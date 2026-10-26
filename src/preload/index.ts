import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { ProbedImageSize } from '../shared/imageSize'
import type {
  AiClassifyBatchResult,
  AiClassifyPayload,
  AiClassifySettings,
  AiClassifyTestResult,
  AssignCategoryPayload,
  AssignCategoryResult,
  Asset,
  FetchZhimoCoverPayload,
  FetchZhimoCoverResult,
  FetchZhimoMetaPayload,
  FetchZhimoMetaResult,
  HdrPrepareResult,
  HdrProgressEvent,
  ImportBatchDoneEvent,
  ImportConflictAnswer,
  ImportConflictAsk,
  ImportConflictContext,
  ImportConflictExpired,
  ImportEvent,
  LayoutApplyResult,
  LogExportResult,
  LogStats,
  MergeMaterialDetectResult,
  MergeMaterialPayload,
  MergeMaterialResult,
  MergeMaterialRollbackResult,
  RendererLogPayload,
  RenameFolderPlanItem,
  RenameFoldersResult,
  RescanResult,
  SaveBallThumbPayload,
  SetCoverImagePayload,
  SetCoverImageResult,
  Settings,
  ThumbFileEntry,
  TrashPurgeItem,
  TrashPurgeResult,
  TrashRestoreItem,
  TrashRestoreResult,
  TrashSoftDeleteItem,
  TrashSoftDeleteResult,
  TrashSweepResult,
  UpdateInfo
} from '../shared/types'

/**
 * 渲染进程可用的全部 API（T05 照此签名写渲染层）。
 * 约定：新增通道必须同时改 `shared/ipc.ts` + `preload/index.ts` + `main/index.ts`，三处缺一不可。
 */
const api = {
  // ── 导入 ────────────────────────────────────────────────────
  /**
   * 导入一批路径（压缩包 / 单图）。
   *
   * `ctx`（docs/27）：判重快照。渲染层在调用前用当前库算出 `ImportDedupeEntry[]`
   * 一次传进来（主进程拿不到 Dexie）；**不传 = 不做重复检测**，行为与 0.6.9 完全一致
   * （静默保留两者）。主进程仍会对每条 `folder` 做库内校验，不能靠它绕过安全边界。
   */
  importPaths: (paths: string[], ctx?: ImportConflictContext): Promise<Asset[]> =>
    ipcRenderer.invoke(IPC.importPaths, paths, ctx),
  /**
   * 订阅「导入发现重复，请裁决」（docs/27）。
   *
   * 返回退订函数（与 `onImportEvent` 同款）：组件卸载必须调用，否则重复注册会让
   * 同一次询问被处理多次。
   */
  onImportConflictAsk: (cb: (ask: ImportConflictAsk) => void): (() => void) => {
    const handler = (_: unknown, ask: ImportConflictAsk) => cb(ask)
    ipcRenderer.on(IPC.importConflictAsk, handler)
    return () => {
      ipcRenderer.off(IPC.importConflictAsk, handler)
    }
  },
  /**
   * 答复一次重复询问。主进程按 `requestId` 兑现挂起的 Promise；
   * **过期 requestId 会被静默丢弃**（超时后迟到的答复不能影响后续批次）。
   */
  answerImportConflict: (answer: ImportConflictAnswer): Promise<void> =>
    ipcRenderer.invoke(IPC.importConflictAnswer, answer),
  /**
   * 订阅「这次询问已作废」（主进程 120s 超时后单方面结束）。
   * 收到后必须立刻关掉弹窗——否则它会挂在屏幕上，而用户之后的点击都会被当成过期答复丢弃。
   * 返回退订函数（与其它 `on*` 同款）。
   */
  onImportConflictExpired: (cb: (ev: ImportConflictExpired) => void): (() => void) => {
    const handler = (_: unknown, ev: ImportConflictExpired) => cb(ev)
    ipcRenderer.on(IPC.importConflictExpired, handler)
    return () => {
      ipcRenderer.off(IPC.importConflictExpired, handler)
    }
  },
  onImportEvent: (cb: (ev: ImportEvent) => void): (() => void) => {
    const handler = (_: unknown, ev: ImportEvent) => cb(ev)
    ipcRenderer.on(IPC.importEvent, handler)
    return () => {
      ipcRenderer.off(IPC.importEvent, handler)
    }
  },
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ── 设置 ────────────────────────────────────────────────────
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.setSettings, patch),
  chooseLibrary: (): Promise<Settings | null> => ipcRenderer.invoke(IPC.chooseLibrary),
  pickArchives: (): Promise<string[]> => ipcRenderer.invoke(IPC.pickArchives),
  pickWatchDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickWatchDir),

  // ── Shell ───────────────────────────────────────────────────
  openPath: (p: string): Promise<string | null> => ipcRenderer.invoke(IPC.openPath, p),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke(IPC.reveal, p),
  trashPaths: (paths: string[]): Promise<string[]> => ipcRenderer.invoke(IPC.trashPaths, paths),
  openLibrary: (): Promise<string | null> => ipcRenderer.invoke(IPC.openLibrary),

  // ── 资产 ────────────────────────────────────────────────────
  renameAsset: (folder: string, newName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.renameAsset, folder, newName),
  /**
   * 批量重命名资产**文件夹**（0.6.0，docs/22 §3.4）。
   *
   * 只改文件夹名，**不改包里的文件**。主进程先整体预检（越界 / 目标已存在 / 非法名）
   * 再逐条 rename，任何一条失败会把已成功的**反向改回**（`rolledBack:true` = 磁盘零改动）。
   * 返回的 `renamed` 携带**最终落盘值**，渲染层照抄写 Dexie（不要自己拼路径）。
   */
  renameFolders: (plan: RenameFolderPlanItem[]): Promise<RenameFoldersResult> =>
    ipcRenderer.invoke(IPC.renameFolders, plan),
  /** 重扫库目录：返回资产 + 结构不符被跳过的清单（RA6，UI 提示数量用） */
  rescan: (): Promise<RescanResult> => ipcRenderer.invoke(IPC.rescan),
  sevenZipPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.sevenZipPath),

  // ── T04 新增：拖出 / 缩略图 / 磁盘 / 索引备份 ──────────────────
  /**
   * 拖出到 DCC。**必须 send 不是 invoke**（同步发起拖拽手势）。
   * @param absPath 要拖出的文件绝对路径（必须是库目录内的文件）
   * @param thumbName 该资产的缩略图缓存文件名，用于拖拽图标；缺省回退 resources/drag-icon.png
   * @param cardPng 可选：hover 预热好的 168×210 卡片 PNG。main 优先用它做拖拽图标
   *                （`nativeImage` 解码失败/为空时自动回退 `thumbName`），不传即保持旧行为
   */
  startDrag: (absPath: string, thumbName?: string | null, cardPng?: Uint8Array | null): void => {
    ipcRenderer.send(IPC.dragStart, absPath, thumbName ?? null, cardPng ?? null)
  },
  /** 生成缩略图；返回缓存文件名，无封面/失败返回 null */
  ensureThumb: (id: string, coverAbs: string | null): Promise<string | null> =>
    ipcRenderer.invoke(IPC.thumbEnsure, id, coverAbs),
  /**
   * 生成 / 复用 **≤1024 预览图**（拖拽卡片专用，docs/26 方案 C+H），返回缓存文件名。
   *
   * - 幂等：文件已存在时主进程直接返回文件名（只 stat，**不解码原图**）；
   * - `null` = 源文件不存在 / 解码不了（TGA、EXR 等）/ 写盘失败 → 调用方回退缩略图；
   * - 拿到文件名后用 `thumbVaultUrl(name)` 拼 `vault://thumb/<name>` 即可。
   * `absPath` 必须在库目录内（主进程会做越界校验，越界返回 null）。
   */
  ensurePreview: (id: string, absPath: string | null): Promise<string | null> =>
    ipcRenderer.invoke(IPC.thumbPreview, id, absPath),
  /** 删除某资产的全部缩略图，返回删掉的数量 */
  deleteThumb: (id: string): Promise<number> => ipcRenderer.invoke(IPC.thumbDelete, id),
  /**
   * 删除某资产的**单个**缓存文件（材质球调参持久化：先建新、再删旧，见 12 §4.2）。
   * main 侧三道校验：文件名可解析、id 匹配、路径在 thumbs 根内。
   * 校验不过返回 false，**不会**删除任何文件。
   */
  deleteOneThumb: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.thumbDeleteOne, id, name),
  /** 清理孤儿缓存，返回删掉的数量 */
  pruneThumbs: (liveIds: string[]): Promise<number> => ipcRenderer.invoke(IPC.thumbPrune, liveIds),
  /**
   * **只读**列出缩略图缓存目录里的文件（`name` / `size` / `mtimeMs`）。
   *
   * 只给"盘上有什么"，**没有任何删除能力**；用于把被 rescan 抹掉的 `thumbPath`
   * 按 `<id>-<8hex>` 精确挂回。⚠️ 不要用 `pruneThumbs` 做探测（它会删文件）。
   */
  listThumbs: (): Promise<ThumbFileEntry[]> => ipcRenderer.invoke(IPC.thumbList),
  /** 清空缩略图缓存，返回清掉的数量 */
  clearThumbs: (): Promise<number> => ipcRenderer.invoke(IPC.thumbClear),
  /** 缓存统计：设置面板显示「当前缓存数量 / 占用」 */
  thumbStats: (): Promise<{ count: number; bytes: number }> => ipcRenderer.invoke(IPC.thumbStats),
  /** 查询某目录所在盘可用字节数；不传目录则查库目录所在盘 */
  diskFree: (dir?: string | null): Promise<number | null> =>
    ipcRenderer.invoke(IPC.diskFree, dir ?? null),
  /** 导出索引快照：弹出保存对话框并写入，返回保存路径；用户取消返回 null */
  exportIndexBackup: (json: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.indexBackup, json),

  // ── T06 新增：分类指派 / 遗留布局迁移 ──────────────────────
  /**
   * 指派分类：把资产目录移动到 <大类>/<一级>/<二级>/。
   * 只移动目录；**缩略图重生（先生成新、再通配删旧）与 Dexie 更新由渲染层负责**。
   * 返回 null = 入参不合法或源目录不存在。
   */
  assignCategory: (payload: AssignCategoryPayload): Promise<AssignCategoryResult | null> =>
    ipcRenderer.invoke(IPC.assignCategory, payload),
  /** 遗留布局迁移（2/3 段 → 4 段双哨兵）；计划 >50 条建议改为手动触发（03 §4.4） */
  migrateLayout: (assets: Asset[]): Promise<LayoutApplyResult> =>
    ipcRenderer.invoke(IPC.migrateLayout, assets),

  // ── 2026-10-19 材质大类合并（docs/14 §2.3） ────────────────────
  /**
   * 只读探测：库里是否还有 `贴图/` / `材质预设/` 资产待合并。**零写入**（不建目录）。
   * 启动时主进程也会主动 probe 一次，经 `onMaterialMergeNotice` 推给渲染层。
   */
  detectMaterialMerge: (): Promise<MergeMaterialDetectResult> =>
    ipcRenderer.invoke(IPC.detectMaterialMerge),
  /**
   * 执行材质大类合并（逐资产搬进 `材质/`，重名加 -2，先写 manifest 再动盘）。
   * - 只搬磁盘；**DB 的 folder/relFolder 更新由渲染层在单个事务里做**（本函数返回最终落盘值）
   * - `payload.force=false` 且待迁移数 > 50 → 返回 `needsManual:true`，磁盘零改动
   * - `payload.assets` 传全部资产引用，main 会把 `assetId`/旧 `relFolder` 写进 manifest（回滚凭据）
   */
  mergeMaterial: (payload?: MergeMaterialPayload): Promise<MergeMaterialResult> =>
    ipcRenderer.invoke(IPC.mergeMaterial, payload ?? {}),
  /** 回滚某份 manifest（P2 UI 未做，函数已可用）；只处理已搬移项，绝不覆盖已占用的源路径 */
  rollbackMaterialMerge: (manifestPath: string): Promise<MergeMaterialRollbackResult> =>
    ipcRenderer.invoke(IPC.rollbackMaterialMerge, manifestPath),
  /** 订阅启动探测通知（发现旧大类目录待合并）；返回退订函数 */
  onMaterialMergeNotice: (cb: (info: MergeMaterialDetectResult) => void): (() => void) => {
    const handler = (_: unknown, info: MergeMaterialDetectResult) => cb(info)
    ipcRenderer.on(IPC.materialMergeNotice, handler)
    return () => {
      ipcRenderer.off(IPC.materialMergeNotice, handler)
    }
  },

  // ── 2026-10 装机反馈：截图/本地图片设为封面（任务 3） ─────────────
  /**
   * 把剪贴板/本地图片写进资产文件夹并设为封面的**前半程**：main 侧校验
   * （PNG/JPEG magic bytes + ≤20MB + 资产目录在库内）后落盘
   * `<资产名>.cover.<ext>`，返回 rel 与字节数；失败返回 null。
   * 后半程（coverSource='manual' + 缩略图重生）由渲染层 setCover 完成。
   */
  setCoverImage: (payload: SetCoverImagePayload): Promise<SetCoverImageResult | null> =>
    ipcRenderer.invoke(IPC.setCoverImage, payload),

  // ── 知末封面抓取（docs/24，T-03） ────────────────────────────────
  /**
   * 从知末详情页抓模型主图当封面（**前半程**：主进程抓取 + 落盘
   * `<资产名>.cover.<ext>`，PNG 源保留 PNG）。返回扁平结果：
   * `{ ok:true, rel, size, width, height, sourceHost, watermarked, title }`
   * 或 `{ ok:false, reason }`。
   *
   * 后半程（`cover` / `coverSource='zhimo'` / `files` 合并 / 缩略图重生）由渲染层
   * store 的 `commitCover` 完成 —— 主进程拿不到 IndexedDB。
   * 失败**不抛错**（IPC 表面只有一种形状，渲染层 `if (!r.ok)` 即可）。
   */
  fetchZhimoCover: (payload: FetchZhimoCoverPayload): Promise<FetchZhimoCoverResult> =>
    ipcRenderer.invoke(IPC.fetchZhimoCover, payload),

  /**
   * **只取详情页**拿站方元信息（分类 / 风格 / 版本 / 标题），**绝不下图片、不写盘**。
   *
   * 返回 `{ ok:true, classifyBaseName, style, version, title }`
   * 或 `{ ok:false, reason }`；四个字段为 `null` 是**正常结果**（站方没给），不是失败。
   *
   * 用途：只需要站方分类时**不要**调 `fetchZhimoCover` —— 后者要下到图且 ≥200px
   * 才算成功，图挂了会让已经拿到的分类一起丢。
   * 分类落库前必须查 `shared/zhimoTaxonomyMap.ts` 的 `mapZhimoCategory()`。
   */
  fetchZhimoMeta: (payload: FetchZhimoMetaPayload): Promise<FetchZhimoMetaResult> =>
    ipcRenderer.invoke(IPC.fetchZhimoMeta, payload),

  // ── HDR 预览（0.6.5） ─────────────────────────────────────────────
  /**
   * 准备 HDR 预览（主进程流式解码 + 降采样 + 缓存）。
   *
   * 源图可能有 300MB+、16384×8192 —— 解码**必须在主进程**做，渲染进程只拿
   * ≤4096 宽的产物（否则 `MAX_TEXTURE_SIZE` 爆 + 1.6GB 内存直接崩渲染进程）。
   *
   * @param filePath 源 `.hdr` 绝对路径（`assetFileAbs(asset.folder, file.rel)`）
   * @param targetWidth 目标宽度，只接受 `512 | 2048 | 4096`（其他值主进程夹到最近的，缺省 2048）
   * @returns `{ ok:true, cachedPath, width, height, fromCache }` 或 `{ ok:false, reason }`；
   *          **不抛错**（失败原因写在 `reason` 里，可直接展示给用户）
   */
  prepareHdr: (filePath: string, targetWidth?: number): Promise<HdrPrepareResult> =>
    ipcRenderer.invoke(IPC.hdrPrepare, { path: filePath, targetWidth }),

  /**
   * 订阅 HDR 解码进度。**必须用返回的函数退订**（组件卸载 / 弹窗关闭），
   * 否则 `ipcRenderer.on` 的监听器会随每次打开预览累积泄漏。
   *
   * `ev.path` 用于过滤：多个资产并发准备时只认自己那条，否则进度条串台。
   */
  onHdrProgress: (cb: (ev: HdrProgressEvent) => void): (() => void) => {
    const handler = (_: unknown, ev: HdrProgressEvent) => cb(ev)
    ipcRenderer.on(IPC.hdrProgress, handler)
    return () => {
      ipcRenderer.off(IPC.hdrProgress, handler)
    }
  },

  // ── 2026-10：材质球离屏渲染图落盘（任务 6） ────────────────────
  /**
   * 把渲染出的材质球**透明 PNG**（base64）写进 thumbs 目录，返回缓存文件名
   * （`<assetId>-<槽位hash>.png`，与既有缩略图同格式，故 delete/prune/stats 自动生效）。
   * 透明背景 → 卡片 `bg-canvas` 透出来，深浅主题共用同一个缓存文件。
   * 网格因此只读 `vault://thumb/<name>`，**永不开 WebGL**。失败返回 null。
   *
   * 载荷里的 `params` / `shape` 都参与文件 hash（`shape` 只在非球面时），
   * 由渲染层传**实际渲染的那一份**——主进程复用 shared 的 `ballThumbName`，不另算一套。
   */
  saveBallThumb: (payload: SaveBallThumbPayload): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveBallThumb, payload),

  // ── 2026-10：尺寸回填（分辨率筛选） ─────────────────────────────
  /**
   * 只读探测一批文件的宽高（主进程读文件头，64KB，不解码整图）。
   *
   * 用途：老库的资产从来没采过 `w/h`（0.6.0 起才在导入时采集），筛选因此"失效"。
   * 渲染层按自己的节奏分批调用，把结果写回 Dexie。
   *
   * @param folder 资产文件夹**绝对路径**（必须在库根内，main 侧越界校验不过返回空数组）
   * @param rels   相对该文件夹的 posix 路径（如 `pbugp_2K_Albedo.jpg`）
   * @returns 读得出尺寸的条目（`rel` 原样回传，调用方按它落位）；
   *          单次最多 200 条，读不出 / 越界的条目**静默省略**（永不 reject）
   */
  probeSizes: (folder: string, rels: string[]): Promise<ProbedImageSize[]> =>
    ipcRenderer.invoke(IPC.probeSizes, folder, rels),

  // ── 2026-10 UI 规范 v0.2：无边框窗口控制（§3.1/§4-2）+ 应用版本 ──
  /** 最小化窗口（send） */
  winMinimize: (): void => {
    ipcRenderer.send(IPC.winMinimize)
  },
  /** 最大化 / 还原切换（send；状态变化经 onMaximizeChange 回推） */
  winMaximizeToggle: (): void => {
    ipcRenderer.send(IPC.winMaximizeToggle)
  },
  /** 关闭窗口（send） */
  winClose: (): void => {
    ipcRenderer.send(IPC.winClose)
  },
  /** 订阅最大化状态变化（□ / ❐ 图标切换）；返回退订函数 */
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on(IPC.winMaximizedEvent, handler)
    return () => {
      ipcRenderer.off(IPC.winMaximizedEvent, handler)
    }
  },
  /** 应用版本号（读 package.json version，主进程 app.getVersion()） */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.getAppVersion),
  /**
   * 检查 GitHub 最新正式版。
   *
   * @param force true = 绕过主进程 10 分钟缓存（「立即检查」按钮传 true；
   *              启动自动检查传 false，同一会话内重复调用直接拿缓存）
   * @returns `UpdateInfo`；**永远 resolve**（网络 / HTTP / 解析失败写在 `error` 字段）
   */
  checkUpdate: (force?: boolean): Promise<UpdateInfo> =>
    ipcRenderer.invoke(IPC.checkUpdate, force === true),
  /** 用系统默认浏览器打开 http(s) 外链；非法协议 / 打开失败返回 false */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.openExternal, url),

  // ── 2026-10-19 AI 辅助分类（docs/15 §7，词表优先 + 模型兜底） ────────
  /**
   * 请求一批资产名的分类结论（每次建议 ≤20 个名字）。
   * **请求由主进程发出**（渲染进程受 CORS / CSP 限制）；密钥只存在主进程 settings，
   * 这里不传、也拿不到。
   * 返回 `items` 与 `names` 等长同序，`null` = 未识别 / 该批失败。
   */
  aiClassify: (payload: AiClassifyPayload): Promise<AiClassifyBatchResult> =>
    ipcRenderer.invoke(IPC.aiClassify, payload),
  /** 「测试连接」：发一条最小请求，回报成功 / 失败原因（允许未启用时测试） */
  aiClassifyTest: (settings: AiClassifySettings): Promise<AiClassifyTestResult> =>
    ipcRenderer.invoke(IPC.aiClassifyTest, settings),
  /**
   * 订阅「一个导入批次已结束」。渲染层据此**后台**补分类（fire-and-forget，不阻塞导入）。
   * 覆盖 UI 导入与监控目录两条入口。返回退订函数。
   */
  onImportBatchDone: (cb: (ev: ImportBatchDoneEvent) => void): (() => void) => {
    const handler = (_: unknown, ev: ImportBatchDoneEvent) => cb(ev)
    ipcRenderer.on(IPC.importBatchDone, handler)
    return () => {
      ipcRenderer.off(IPC.importBatchDone, handler)
    }
  },

  // ── 2026-10 诊断日志（崩溃取证 + 用户自助导出） ───────────────────
  /**
   * 日志目录 / 文件数 / 总大小（设置·数据与备份 的「诊断日志」区块）。
   * 只统计 `app-YYYY-MM-DD.log`，与清理/导出口径一致。
   */
  logStats: (): Promise<LogStats> => ipcRenderer.invoke(IPC.logStats),
  /**
   * 导出诊断日志：主进程弹保存对话框并把 logs 目录打成 zip。
   * `canceled: true` = 用户取消（UI 不提示失败）；`path: null` 且未取消 = 打包失败。
   */
  exportLogs: (): Promise<LogExportResult> => ipcRenderer.invoke(IPC.logExport),
  /**
   * 转发一条渲染侧日志（**send**，fire-and-forget：日志不该拖慢渲染）。
   * 调用方（渲染入口）负责去重 / 限流：同一消息 10 秒内只记一次、总量 20 条/10 秒。
   */
  reportLog: (payload: RendererLogPayload): void => {
    ipcRenderer.send(IPC.logWrite, payload)
  },

  // ── C 线：库内「最近删除」（docs/20 §4） ─────────────────────────
  //
  // 保留期非 recycle 档才用这几个通道；`recycle` 档继续走上面的 `trashPaths`（旧行为）。
  // 磁盘动作全在主进程；**Dexie 更新由渲染层按返回值照抄写库**（含最终 folder/relFolder）。
  /** 软删：批量移到 `<库根>/.trash/`；返回每项 trashRel / deletedAt / size 与失败清单 */
  softDeleteAssets: (items: TrashSoftDeleteItem[]): Promise<TrashSoftDeleteResult> =>
    ipcRenderer.invoke(IPC.trashSoftDelete, items),
  /** 还原：搬回原路径；`renamed=true` 表示原位置被占、追加了序号（UI 必须提示） */
  restoreAssets: (items: TrashRestoreItem[]): Promise<TrashRestoreResult> =>
    ipcRenderer.invoke(IPC.trashRestore, items),
  /** 彻底删除：指定项 → **系统回收站** */
  purgeAssets: (items: TrashPurgeItem[]): Promise<TrashPurgeResult> =>
    ipcRenderer.invoke(IPC.trashPurge, items),
  /** 清空回收区：全部 → 系统回收站 */
  emptyTrash: (): Promise<TrashPurgeResult> => ipcRenderer.invoke(IPC.trashEmptyAll),
  /** 到期 / 超容量清理（设置页手动触发；启动与 6 小时定时由主进程自己跑） */
  sweepTrash: (opts?: { retentionDays?: number; maxBytes?: number }): Promise<TrashSweepResult> =>
    ipcRenderer.invoke(IPC.trashSweep, opts)
}

contextBridge.exposeInMainWorld('modvault', api)

export type ModVaultApi = typeof api
