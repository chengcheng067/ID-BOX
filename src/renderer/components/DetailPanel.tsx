import { useEffect, useMemo, useState } from 'react'
import { useVault } from '../store'
import { KIND_LABEL, KIND_GROUP_MEMBERS } from '../../shared/classify'
import { UNCLASSIFIED, styleListOf } from '../../shared/taxonomy'
import { formatBytes, formatDate, thumbVaultUrl, vaultUrl } from '../../shared/format'
import { assetFileAbs } from '../logic/assetPath'
import { beginSystemDrag } from '../logic/dragOut'
import { cachedDragCard, cancelDragCardPrewarm, dragCardKey, prewarmDragCard } from '../logic/dragCard'
import { peekPreviewUrl } from '../logic/previewThumb'
import { IMAGE_FILE_EXTS } from '../../shared/imageExts'
import { categoriesOf } from '../logic/category'
import { duplicatesOf, groupOf, keepOnlyTargets } from '../logic/duplicates'
import { groupFilesBySlot } from '../logic/fileGroups'
import { effectiveMaterialSlots } from '../logic/materialBall'
import {
  coverImageInputOf,
  firstImageFileOfDataTransfer
} from '../logic/coverImage'
import { isDeletedAsset, trashNoticeText } from '../logic/trashView'
import { undoGraceHint, undoGraceSuffix } from '../logic/graceText'
import { DEFAULT_UNDO_GRACE_MS } from '../../shared/undoGrace'
import { EMPTY_ALIASES, aliasIndexOf, resolveAssetDisplayName } from '../logic/aliasIndex'
import { zhimoIdOf } from '../../shared/naming'
import { CoverPicker } from './CoverPicker'
import { DuplicateCompareDialog } from './DuplicateCompareDialog'
import { PurgeConfirmDialog } from './PurgeConfirmDialog'
import { CustomRenderDialog } from './CustomRenderDialog'
import { ColorTagPicker, StarIcon, StarRating } from './MarkControls'
import {
  IconBox, IconExternal, IconFile, IconFolder, IconHdr, IconImage,
  IconMaterial, IconOther, IconTrash, IconClose, IconEmptyPointer, IconRefresh
} from '../icons'
import type { Asset, AssetFile, AssetKind } from '../../shared/types'
import type { DragEvent } from 'react'

const KIND_ICON: Record<AssetKind, typeof IconBox> = {
  model: IconBox,
  texture: IconImage,
  hdri: IconHdr,
  material: IconMaterial,
  other: IconOther
}

/**
 * 「材质大类」的 kind 集合 —— 取 `shared/classify` 的分组唯一定义
 * （`texture` + `material`），不在组件里手写 `['texture','material']`。
 * 反馈 4（docs/15 §4）：材质大类合并后 `texture` 只是 kind 属性，
 * 渲球门禁必须按「属于材质大类」判定，否则会出现「贴图并进材质大类却不能渲球」。
 */
const MATERIAL_KINDS: ReadonlySet<AssetKind> = new Set(KIND_GROUP_MEMBERS.materialGroup)

/**
 * 详情面板里的单个文件行（§3.4：高 28，名称 + 体积右对齐）；**可单独拖出到 DCC**。
 *
 * `readOnly`（软删态）：文件已随目录搬进 `.trash/`，`abs`（按原 folder 拼）是死路径 →
 * 不挂拖出、不响应双击、不显示「在资源管理器中显示」。仅保留文件名与体积供用户辨认。
 */
function FileRow({ asset, file, readOnly = false }: { asset: Asset; file: AssetFile; readOnly?: boolean }) {
  const abs = assetFileAbs(asset.folder, file.rel)
  /**
   * 拖拽卡片（2026-10-21，与网格/文件视图同源）：原来只传缩略图路径，拖起来的影像
   * 由系统随手画（会被裁切、没有卡片外观）。这里 hover 预热同一张 176×176 卡片位图，
   * dragstart 同步读缓存。
   *
   * 2026-10（docs/26 方案 C + H）：图片文件的底图改成 **≤1024 预生成预览图**，
   * 不再把原图 URL 塞进 canvas（8K 贴图拖一次要解码几十 MB —— 这是本次要修的性能问题）。
   * 取值优先级：
   * ① 已生成过的预览图（`peekPreviewUrl`：同步、零 IPC，第二次 hover 走这条）；
   * ② 资产缩略图（480，最便宜）；
   * ③ 原图（前两者都没有时的兜底，保证卡片**永远不空白**）。
   *
   * 预览的**生成**放在 hover 预热里（下面的 `preview` 参数 → 主进程 `thumb:preview`），
   * 因为 `startDrag` 必须在 dragstart 的同步段发起，不能在那里等 IPC。
   */
  const cardKey = dragCardKey(asset.id, file.rel)
  const isImageFile = IMAGE_FILE_EXTS.has(file.ext.toLowerCase())
  const assetThumbUrl =
    asset.thumbStatus === 'ready' && asset.thumbPath ? thumbVaultUrl(asset.thumbPath) : null
  const cardThumb = isImageFile
    ? peekPreviewUrl(asset.id, abs) ??
      assetThumbUrl ??
      vaultUrl(asset.relFolder ? `${asset.relFolder}/${file.rel}` : file.rel)
    : assetThumbUrl
  const onDragStart = (e: DragEvent) => {
    // 拖单个文件（贴图 / HDRI 单拖是高频场景）。
    // 统一走 beginSystemDrag：第一步 preventDefault 取消渲染进程自己的 HTML5 拖拽，
    // 否则会与主进程 startDrag 的 OLE 拖拽重入 → Windows 原生崩溃（2026-10 闪退事故）。
    const cardPng = cachedDragCard(cardKey)
    beginSystemDrag(e, file.name, abs, asset.thumbPath ?? null, (path, thumb) =>
      window.modvault.startDrag(path, thumb, cardPng)
    )
  }
  return (
    <div
      className="group flex h-7 items-center gap-2 rounded-md px-2 text-[12px] transition hover:bg-elevated/60"
      onMouseEnter={
        readOnly
          ? undefined
          : () =>
              prewarmDragCard(cardKey, {
                thumbUrl: cardThumb,
                name: file.name,
                // 只有图片文件才值得请求预览：模型 / HDR / 压缩包不是 <img> 能解的，
                // 请求了也只会拿到 null（主进程 nativeImage 读不出来）。
                preview: isImageFile ? { id: asset.id, absPath: abs } : null
              })
      }
      onMouseLeave={readOnly ? undefined : () => cancelDragCardPrewarm()}
      {...(readOnly
        ? {}
        : {
            draggable: true,
            onDragStart,
            onDoubleClick: () => window.modvault.openPath(abs),
            title: '双击用默认程序打开；可直接拖到 SketchUp / D5 等软件'
          })}
    >
      <span className="text-tertiary">
        <IconFile width={13} height={13} />
      </span>
      {/* 走查 v0.2.2 B6#35（灰阶按已拍板 B2#6）：文件行文字画布 2:144 是 #4B5563 = secondary，
          此前继承 primary → 归 secondary。 */}
      <span className="flex-1 truncate text-secondary" title={file.rel}>
        {file.name}
      </span>
      <span className="shrink-0 text-[11px] text-muted">{formatBytes(file.size)}</span>
      {!readOnly && (
        <button
          className="shrink-0 rounded p-0.5 text-muted opacity-0 transition hover:bg-elevated hover:text-primary group-hover:opacity-100"
          onClick={() => window.modvault.reveal(abs)}
          title="在资源管理器中显示"
        >
          <IconExternal width={13} height={13} />
        </button>
      )}
    </div>
  )
}

/**
 * 详情面板里的「一级 / 二级分类」行（可点击指派）。
 *
 * 形态沿用面板既有的行（`FileRow` / 重复副本行）：h-7、悬停 `bg-elevated/60`，
 * 左侧 48px 标签 + 值（`truncate`）+ 右侧动作提示。
 *
 * 「未分类」必须走**占位文案**（tertiary 灰 + 蓝色「＋ 指派」），不能渲染成一行空白：
 * 空白行会被读成「面板坏了」，而这正是用户要「点一下就能建分类」的入口。
 */
function CategoryRow({
  label,
  value,
  disabled = false,
  onClick
}: {
  label: string
  value: string
  disabled?: boolean
  onClick: () => void
}) {
  const unclassified = value === UNCLASSIFIED
  return (
    <button
      type="button"
      className="flex h-7 w-full items-center gap-2 px-2 text-left text-[12px] transition hover:bg-elevated/60 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onClick}
      title={
        disabled
          ? '已删除的资产不能改分类，请先还原'
          : unclassified
            ? '点击指派分类（先选一级，再选二级）'
            : '点击更改分类（先选一级，再选二级）'
      }
    >
      <span className="w-[48px] shrink-0 text-[11px] text-muted">{label}</span>
      <span className={`min-w-0 flex-1 truncate ${unclassified ? 'text-tertiary' : 'text-primary'}`}>
        {unclassified ? UNCLASSIFIED : value}
      </span>
      {!disabled && (
        <span className={`shrink-0 text-[10px] ${unclassified ? 'text-accent-text' : 'text-muted'}`}>
          {unclassified ? '＋ 指派' : '更改'}
        </span>
      )}
    </button>
  )
}

export function DetailPanel() {
  const assets = useVault((s) => s.assets)
  const selectedId = useVault((s) => s.selectedId)
  const selectedIds = useVault((s) => s.selectedIds)
  const select = useVault((s) => s.select)
  const requestDelete = useVault((s) => s.requestDelete)
  const openCategoryPicker = useVault((s) => s.openCategoryPicker)
  const renameAsset = useVault((s) => s.renameAsset)
  const updateAsset = useVault((s) => s.updateAsset)
  // C 线「最近删除」：软删态下的还原 / 彻底删除
  const restoreAssets = useVault((s) => s.restoreAssets)
  const trashRetention = useVault((s) => s.settings?.trashRetention ?? '30d')
  /**
   * 删除撤销期（设置·数据与备份，三档 0 / 3000 / 5000）。
   * 本面板有 3 处提示文案提到「5 秒内可撤销」，必须跟着设置渲染，
   * 否则用户改成 3 秒 / 不等待后提示会自相矛盾（`undoGraceSuffix` 统一口径）。
   */
  const undoGraceMs = useVault((s) => s.settings?.undoGraceMs ?? DEFAULT_UNDO_GRACE_MS)
  // v0.4 标记（收藏 / 评分 / 色标）：多选时作用于全部选中项
  const setFavorite = useVault((s) => s.setFavorite)
  const setRating = useVault((s) => s.setRating)
  const setColorTag = useVault((s) => s.setColorTag)
  /**
   * 别名索引（0.6.0 §3.3）：按 `settings.aliases` 的引用 memo（与网格共用同一份 Map）。
   * 详情面板里**只有「显示名」一行**走别名；标题输入框是**改名控件**（写磁盘），
   * 必须继续显示真实名 —— 否则用户一失焦就把文件夹改成了别名。
   */
  const aliases = useVault((s) => s.settings?.aliases) ?? EMPTY_ALIASES
  const aliasIndex = aliasIndexOf(aliases)
  // 知末封面（docs/24，T-05）：手动「从知末取封面」——**不受两个设置开关约束**
  // busy 按**资产**记（自动批次在后台跑时不该让别的资产也显示"获取中"）
  const zhimoCoverBusyId = useVault((s) => s.zhimoCoverBusyId)
  const refreshZhimoCover = useVault((s) => s.refreshZhimoCover)
  const asset = assets.find((a) => a.id === selectedId) ?? null

  const [nameEdit, setNameEdit] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [coverPickerOpen, setCoverPickerOpen] = useState(false)
  const [coverDragOver, setCoverDragOver] = useState(false)
  const [renderOpen, setRenderOpen] = useState(false)
  /** 重复副本并排对比弹窗（2026-10 用户反馈：只列路径不够直观） */
  const [compareOpen, setCompareOpen] = useState(false)
  /** 「彻底删除」二次确认（软删态才可达）；true = 弹窗打开 */
  const [purgeOpen, setPurgeOpen] = useState(false)
  /**
   * HDR 预览入口（0.6.5）：**不在这里持弹窗 state**。
   * 网格双击 / 文件行双击 / 本按钮三处共用 store 的 `hdrPreviewAssetId`，
   * 弹窗本体只在 `App.tsx` 挂一次（lazy）—— 否则会出现两个实例 / 关不掉的幽灵窗。
   */
  const openHdrPreview = useVault((s) => s.openHdrPreview)

  // 风格受控词表按大类分册（06 §9.1）；无词表的大类隐藏整个风格区
  const styleOptions = asset ? styleListOf(asset.kind) : []
  /**
   * 风格区的**显示条件**：有词表 **且** 不属于材质大类。
   *
   * 2026-10 用户拍板（原话）：「材质的右侧栏这个地方是不显示风格的，因为材质不存在什么
   * 风格不风格的问题，直接就是显示一级分类、二级分类。」
   * - `texture` / `material` → **不渲染**（`MATERIAL_KINDS` 就是 `KIND_GROUP_MEMBERS.materialGroup`
   *   的唯一定义，与「材质大类」的其余判据同源，不在组件里手写 `['texture','material']`）；
   * - `model` → 有 20 项词表，照常渲染（不受影响）；
   * - `hdri` / `other` → 本来就无词表（`styleListOf` 返回 `[]`），行为一字未改。
   */
  const showStyleBlock = styleOptions.length > 0 && asset !== null && !MATERIAL_KINDS.has(asset.kind)
  const assetStyles = asset?.styles ?? []
  const { category1, category2 } = asset
    ? categoriesOf(asset)
    : { category1: UNCLASSIFIED, category2: UNCLASSIFIED }
  /** 是否已有分类（任一非「未分类」）；只用于分类区块右上角的动作提示文案 */
  const hasCategory = category1 !== UNCLASSIFIED || category2 !== UNCLASSIFIED

  // §3.7 入口判据：属于材质大类（texture / material）且能取得渲球槽位。
  // 反馈 4（docs/15 §4）：单图 / 认不出 PBR 命名时，`effectiveMaterialSlots` 会把
  // 第一张图片兜底成 baseColor —— 只要资产里有图片就能渲球。
  const isMaterialFamily = asset !== null && MATERIAL_KINDS.has(asset.kind)
  const renderSlots = useMemo(
    () => (asset && isMaterialFamily ? effectiveMaterialSlots(asset.files) : {}),
    [asset?.id, asset?.files, isMaterialFamily] // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 2026-10-21：必须**有 baseColor** 才提供球预览——只有法线/AO 的资产上球=白球
  const canCustomRender = isMaterialFamily && !!renderSlots.albedo

  // ── v0.4 重复副本：同组其它资产（不含自己）──
  // 注意 hooks 必须在 `if (!asset)` 早返回之前；依赖用 `asset?.id` 保持稳定。
  const dupCopies = useMemo(
    () => (asset ? duplicatesOf(assets, asset.id) : []),
    [assets, asset?.id] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const dupGroup = useMemo(
    () => (asset ? groupOf(assets, asset.id) : null),
    [assets, asset?.id] // eslint-disable-line react-hooks/exhaustive-deps
  )

  /**
   * 「保留某一份，其余移入回收站」：复用既有删除链路（二次确认 → 撤销期 → trashPaths），
   * 不自己写 trash。
   *
   * ⚠️ P0（2026-10 用户报「本体也被删了」）：目标 id 由 `keepOnlyTargets()` 统一计算——
   * 它只取**同一重复组的活着的记录**，并排除要保留的那份。若 `keepId` 本身已软删
   * （回收站视图）→ 返回空数组，这里直接 return，**一个都不会删**。
   */
  const requestKeepOnly = (keepId: string) => {
    if (!asset || asset.deletedAt) return
    const ids = keepOnlyTargets(assets, keepId)
    if (ids.length === 0) return
    requestDelete(ids, {
      warning: dupGroup?.sizeMismatch ? '体积差异较大，请先确认是同一套资产' : undefined,
      // 文案随设置变（5 秒 / 3 秒 / 不等待）
      notice: undoGraceHint(undoGraceMs)
    })
  }

  /** 详情面板里的「保留这份」= 保留**当前选中的这条** */
  const keepThisCopyOnly = () => {
    requestKeepOnly(asset?.id ?? '')
  }

  const toggleStyle = (v: string) => {
    if (!asset) return
    const next = assetStyles.includes(v)
      ? assetStyles.filter((x) => x !== v)
      : [...assetStyles, v]
    void updateAsset(asset.id, { styles: next })
  }

  useEffect(() => {
    setNameEdit(asset?.name ?? '')
    setTagInput('')
    setCoverPickerOpen(false)
    setRenderOpen(false)
    // 切到别的资产时关掉对比弹窗：它的内容绑定在上一组资产上
    setCompareOpen(false)
  }, [asset?.id])

  // 走查 v0.2.2 B2#4：空态同属右栏，浅色走白卡（画布 2:124）
  if (!asset) {
    return (
      <aside className="flex w-[300px] shrink-0 flex-col items-center justify-center gap-2 bg-panel text-muted">
        {/* 图标规格 A：右栏空态图形（40px、单色 currentColor） */}
        <IconEmptyPointer className="text-tertiary" />
        <p className="text-sm">选中一个资产查看详情</p>
      </aside>
    )
  }

  /**
   * 显示名（别名 > 剥知末 ID > 原名）。
   *
   * 只在**与真实名不同**时才在标题下方多显示一行：多数资产没有别名，
   * 多余的一行只会让面板变吵。磁盘上的文件夹名一个字都不改。
   */
  const assetDisplayName = resolveAssetDisplayName(asset, aliasIndex)
  const aliasActive = assetDisplayName !== asset.name

  // 2026-10 用户反馈第 2 条（需求书 §3.2）：文件按 PBR 槽位分组展示，
  // 一眼看清哪个是法线 / AO / 置换；未识别槽位的文件归「其他」组，不丢弃。
  const fileGroups = groupFilesBySlot(asset.files)

  /**
   * C 线「最近删除」：软删态。
   *
   * 软删后资产目录已经搬到 `<库根>/.trash/<id>/`，`relFolder` / `folder` 仍指向**原位置**
   * （还原时要用它算目标路径）。因此：
   * ① 封面不能用 `vault://asset/<relFolder>/...`（会 404）→ 退回缩略图缓存；
   * ② 「打开所在文件夹」指向的旧目录已不存在 → 换成「还原 / 彻底删除」两个动作。
   */
  const deleted = isDeletedAsset(asset)
  const deletedNotice = deleted ? trashNoticeText(asset.deletedAt, trashRetention) : null
  /**
   * 知末 ID（docs/24 §3.2 + 0.6.3）：**优先用落库的 `asset.zhimoId`**，为空再按资产名解析。
   *
   * 为什么不能只看名字：知末有大量包只在**压缩包名**上带 ID，解包后
   * `attachment_1786942463670\现代壁灯\现代壁灯.skp` 零 ID 痕迹 —— 只看名字会让
   * 「从知末取封面」按钮对这类资产永远是灰的（用户 2026-10 反馈的第 1 条）。
   * 取不到就禁用；不提供"让用户手填 ID"的入口（手填会把自动功能变成要维护的输入框）。
   */
  const zhimoId = String(asset.zhimoId ?? '').trim() || zhimoIdOf(asset.name)
  /** 只有**这个资产**在手动抓取时才点亮 loading（自动批次全程不点亮任何资产） */
  const zhimoCoverBusy = zhimoCoverBusyId === asset.id
  /** 软删态封面的图源：缩略图缓存（`vault://thumb`，与网格同源），没有就退回类型图标 */
  const deletedCoverSrc =
    asset.thumbStatus === 'ready' && asset.thumbPath ? thumbVaultUrl(asset.thumbPath) : null
  /**
   * 详情面板封面图源：未删 = 读**原图**（C4：详情面板才允许原图）；
   * 已删 = 读缩略图缓存（原图路径已随目录搬进 `.trash`，旧 `vault://asset/...` 必然 404）。
   *
   * ⚠️ 未删分支必须带 `asset.updatedAt` 作为版本参数（`?v=`）：封面文件是**原地覆盖**的
   * （HDR 预览「拍照」/ 拖图设封面 / 知末抓取都写回同一个 `<资产名>.cover.<ext>`），
   * 路径不变 → URL 不变 → Chromium 直接给磁盘缓存里的旧图，「拍了照但大图没变」。
   * `commitCover()` 每次都会把 `updatedAt` 推进到 `Date.now()`，所以 URL 必然变化。
   */
  const coverSrc = deleted
    ? deletedCoverSrc
    : asset.cover
      ? vaultUrl(`${asset.relFolder}/${asset.cover}`, asset.updatedAt)
      : null

  /**
   * v0.4 标记的作用域：多维选中（Ctrl/Cmd+点）时作用于**全部选中项**，
   * 单选就是当前这一条。面板上的值展示以当前资产为准（多选时它是"代表"）。
   */
  const markIds = selectedIds.length > 1 ? selectedIds : [asset.id]
  const isMultiMark = markIds.length > 1

  const commitRename = () => {
    const v = nameEdit.trim()
    if (v && v !== asset.name) void renameAsset(asset.id, v)
    else setNameEdit(asset.name)
  }

  const addTag = () => {
    const t = tagInput.trim()
    if (t && !asset.tags.includes(t)) void updateAsset(asset.id, { tags: [...asset.tags, t] })
    setTagInput('')
  }

  /** 拖一张图片进详情面板封面区 → 直接设为封面（任务 3 来源②） */
  const applyCoverFile = async (file: File) => {
    const input = await coverImageInputOf(file)
    if (!input) {
      useVault.setState({ notice: '只支持 PNG/JPEG 图片' })
      return
    }
    await useVault.getState().setCoverFromImage(asset.id, input)
  }

  const onCoverDrop = (e: DragEvent) => {
    // 必须阻断冒泡：App.tsx 有 window 级 drop 监听（全窗拖入导入），
    // 不 stopPropagation 的话这张图会**同时**被当成压缩包导入。
    e.preventDefault()
    e.stopPropagation()
    setCoverDragOver(false)
    const file = firstImageFileOfDataTransfer(e.dataTransfer)
    if (file) void applyCoverFile(file)
  }

  // 走查 v0.2.2 B2#4 拍板：浅色右栏走白卡（画布 2:124 fill #FFFFFF + 描边 #E8EDF2）；
  // 深色 --panel-bg 仍为 #161618，本就与画布一致。描边走面板档 --border-panel。
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-panel-line bg-panel">
      {/* C 线：软删态提示条（浅色，右栏最顶部）。文案里的剩余天数与卡片徽标同源
          （`logic/trashView.ts`），不会出现"卡片说还剩 14 天、详情说 15 天"。 */}
      {deletedNotice && (
        <div className="shrink-0 border-b border-line bg-elevated px-4 py-2 text-[11px] leading-relaxed text-secondary">
          {deletedNotice}
        </div>
      )}
      {/* 封面：详情面板读**原图**（vault://asset/...），网格才走缩略图（C4）。
          §3.4：预览区 r14（画布 2:125 浅 / 2:403 深 r10 → --radius-preview 按主题各一套），材质 1:1 / 模型 16:10。
          2026-10-21 用户反馈：**贴图类也是球图**（720×720 方图），塞进 16:10 会被 `object-cover`
          纵向裁掉 37.5%，球看起来"被砍掉一截"。→ 材质 + 贴图统一 1:1；模型仍是 16:10（横向构图，裁切合理）。 */}
      <div className="shrink-0 p-3 pb-0">
        <div
          className={`relative overflow-hidden rounded-preview bg-canvas transition ${
            asset.kind === 'material' || asset.kind === 'texture' ? 'aspect-square' : 'aspect-[16/10]'
          } ${coverDragOver ? 'ring-2 ring-accent ring-inset' : ''}`}
          onDragEnter={(e) => {
            if (Array.from(e.dataTransfer.types).includes('Files')) {
              // 阻断冒泡：避免 App 的全窗拖入导入遮罩同时弹出
              e.stopPropagation()
              setCoverDragOver(true)
            }
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes('Files')) {
              e.preventDefault() // 阻止默认（浏览器直接打开图片）才能触发 drop
              e.stopPropagation()
              setCoverDragOver(true)
            }
          }}
          onDragLeave={() => setCoverDragOver(false)}
          onDrop={onCoverDrop}
          title="可以把一张图片拖到这里直接设为封面"
        >
          {coverSrc ? (
            <img src={coverSrc} className="h-full w-full object-cover" alt="" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted/50">
              <div className="scale-[3]">{<KINDIcon kind={asset.kind} />}</div>
            </div>
          )}
          {coverDragOver && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent/15 text-[13px] font-medium text-accent-text">
              松手把这张图设为封面
            </div>
          )}
          <button
            className="absolute right-2 top-2 rounded-lg bg-black/40 p-1.5 text-white transition hover:bg-black/60"
            onClick={() => select(null)}
            title="关闭详情"
          >
            <IconClose />
          </button>
          {/* §3.7 入口：自定义渲染（材质类且槽位齐全时显示；弹窗内调参 + 保存设为封面） */}
          {canCustomRender && !deleted && (
            <button
              className="absolute bottom-2 left-2 rounded-lg bg-black/45 px-2 py-1 text-[11px] text-white transition hover:bg-black/65"
              onClick={() => setRenderOpen(true)}
              title="自定义渲染：调反光/凹凸强度后保存设为封面"
            >
              自定义渲染
            </button>
          )}
        </div>
        {/* §3.4 更换封面条：--bg-sidebar 底 28px，圆角走 --radius-coverbar（画布 2:126 浅 r9 / 2:404 深 r7）；
            粘贴 / 拖图 / 选文件三来源全在 CoverPicker 里 */}
        {/* 软删态不提供「更换封面」：封面要写进资产目录，而目录已在 `.trash/` 里（原路径不可写） */}
        {!deleted && (
          <button
            className="mt-2 flex h-[28px] w-full items-center justify-center rounded-coverbar bg-sidebar text-[11px] text-secondary transition hover:bg-elevated hover:text-primary"
            onClick={() => setCoverPickerOpen(true)}
            title="更换封面：粘贴截图 / 拖入图片 / 选本地文件 / 资产内图片"
          >
            更换封面 · 粘贴 / 拖图 / 选文件
          </button>
        )}
        {/* docs/24 §5.4：从知末取封面（仅 model）。
            ⚠️ **不受** zhimoCover / zhimoCoverReplacePacked 两个开关约束：
                那两个只约束"导入后自动抓"，用户手动点就是要。
            无 ID → disabled + title 说明（不弹提示，避免一点就报错）。
            抓取中 → 文案切 loading 并禁用重复点击。 */}
        {!deleted && asset.kind === 'model' && (
          <button
            className="mt-1.5 flex h-[28px] w-full items-center justify-center rounded-coverbar bg-sidebar text-[11px] text-secondary transition hover:bg-elevated hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sidebar disabled:hover:text-secondary"
            disabled={!zhimoId || zhimoCoverBusy}
            onClick={() => void refreshZhimoCover(asset.id)}
            title={
              zhimoId
                ? // 明确写"会替换"：按钮不做二次确认（用户 2026-10-22 拍板），
                  // 那就必须把后果写在可 hover 得到的地方
                  '从知末取封面（会替换当前封面）'
                : // 0.6.3：ID 也可能来自**压缩包名**（`现代壁灯ID_1232108421.rar`），
                  // 所以措辞不再限定"资产名里"。同时必须给可行动出路：
                  // 包名派生的 ID **只在导入那一刻可得**（包随后按设置被回收/删除），
                  // 老资产无法事后回填 —— 重新拖入原始压缩包即可补上。
                  '未识别到知末 ID，无法从知末取封面（把原始压缩包重新拖进来可补上）'
            }
          >
            {zhimoCoverBusy ? '正在从知末获取…' : '从知末取封面'}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 py-3">
        {/* v0.4 多选提示：标记区作用于全部选中项（不弹二次确认，一次点击即生效） */}
        {isMultiMark && (
          <div className="mb-2 rounded-lg bg-accent-tint px-2.5 py-1.5 text-[11px] leading-relaxed text-accent-text">
            已选 {markIds.length} 项 · 下方「标记」作用于全部选中项
          </div>
        )}
        {/* 名称（可改名） */}
        <input
          className="w-full rounded-btn border border-transparent bg-transparent px-0 text-[14px] font-semibold text-primary outline-none transition hover:border-line focus:border-accent/60"
          value={nameEdit}
          readOnly={deleted}
          onChange={(e) => setNameEdit(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          title={
            deleted
              ? '已删除的资产不能改名，请先还原'
              : '这里是磁盘上的真实名：改名会同步重命名库内文件夹'
          }
        />

        {/* 别名（0.6.0 §3.3）：只改显示，磁盘名不动。与真实名相同时不渲染（不占位）。 */}
        {aliasActive && (
          <div className="flex items-baseline gap-1.5 text-[11px] text-muted">
            <span className="shrink-0">显示名</span>
            <span
              className="min-w-0 truncate font-medium text-secondary"
              title="别名只改软件里显示的名字，磁盘上的文件名不动"
            >
              {assetDisplayName}
            </span>
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span className="chip">{KIND_LABEL[asset.kind]}</span>
          {/* T07 的分类 chip 已移到下方「分类」区块（一级 / 二级两行）。
              同一个面板里只能有**一处**分类信息：这里再放一个 `一级 / 二级` chip，
              与下方的两行是同一份数据的两份呈现，改起来也会出现「点哪个」的歧义。 */}
          {asset.source && <span className="chip">{asset.source}</span>}
          {/* P0-15：SU 版本 chip */}
          {asset.suVersion && <span className="chip-accent">{asset.suVersion}</span>}
          {asset.mojibake === true && (
            <span className="chip !border-danger/40 !bg-danger-tint text-danger" title="解压出的文件名疑似乱码（GBK 解码失败）">
              疑似乱码
            </span>
          )}
          <span>{asset.files.length} 个文件</span>
          <span>· {formatBytes(asset.size)}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted">导入于 {formatDate(asset.importedAt)}</div>

        {/* 标签 */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted">
            标签
          </div>
          <div className="flex flex-wrap gap-1.5">
            {asset.tags.map((t) => (
              <span key={t} className="chip-accent">
                {t}
                <button
                  className="opacity-60 transition hover:opacity-100"
                  onClick={() => void updateAsset(asset.id, { tags: asset.tags.filter((x) => x !== t) })}
                  title="移除标签"
                >
                  ×
                </button>
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <input
                className="w-20 rounded-chip border border-line bg-card px-1.5 py-0.5 text-xs text-primary outline-none focus:border-accent/60"
                placeholder="+ 添加"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTag()
                }}
                onBlur={addTag}
              />
            </span>
          </div>
        </div>

        {/* ── v0.4 标记：收藏 / 评分 / 色标 ─────────────────────────────
            多选时三个控件都作用于 `markIds`（= 全部选中项），值展示以当前资产为准。
            样式复用既有 chip / 描边分组，不新造控件。 */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[11px] font-medium text-muted">
              标记{isMultiMark ? `（${markIds.length} 项）` : ''}
            </span>
          </div>
          <div className="space-y-2 rounded-slotgroup border border-soft-line px-2 py-2">
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] text-muted">收藏</span>
              <button
                className={asset.favorite === true ? 'chip-accent' : 'chip-ghost'}
                onClick={() => void setFavorite(markIds, asset.favorite !== true)}
                title={asset.favorite === true ? '取消收藏' : '加入收藏'}
              >
                <StarIcon filled={asset.favorite === true} size={12} />
                {asset.favorite === true ? '已收藏' : '收藏'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] text-muted">评分</span>
              <StarRating
                value={asset.rating ?? 0}
                onChange={(v) => void setRating(markIds, v)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] text-muted">色标</span>
              <ColorTagPicker
                selected={asset.colorTag ? [asset.colorTag] : []}
                onToggle={(tag) =>
                  void setColorTag(markIds, asset.colorTag === tag ? null : tag)
                }
              />
            </div>
          </div>
        </div>

        {/* ── v0.4 重复副本 ──────────────────────────────────────────────
            同组其它资产的相对路径 + 体积；「保留这份」走 requestDelete（二次确认 + 5 秒撤销）。
            只有真的存在副本时才渲染，普通资产的面板完全不变。

            ⚠️ P0（2026-10）：**回收站里的记录整块不渲染**。软删记录仍在 `assets` 里，
            若在「最近删除」页显示「保留这份」，语义上等于"从回收站里再删一次"，
            实际会把它唯一活着的同组副本推进回收站（用户实测「本体也被删了」）。
            这里用资产自身的 `deletedAt` 判定，不猜视图。 */}
        {!asset.deletedAt && dupCopies.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-primary">
                重复副本（{dupCopies.length}）
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[10px] text-muted">同一大类下名字相同</span>
                <button
                  className="text-[11px] text-accent-text transition hover:underline"
                  onClick={() => setCompareOpen(true)}
                  title="并排对比各副本的字段差异（缩略图 / 路径 / 体积 / 分类…）"
                >
                  对比
                </button>
              </div>
            </div>
            <div className="rounded-slotgroup border border-soft-line">
              {dupCopies.map((c) => (
                <button
                  key={c.id}
                  className="flex h-7 w-full items-center gap-2 px-2 text-[12px] transition hover:bg-elevated/60"
                  onClick={() => select(c.id)}
                  title={`${c.relFolder}\n点击切到该副本`}
                >
                  <span className="flex-1 truncate text-left text-secondary" title={c.relFolder}>
                    {c.relFolder}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{formatBytes(c.size)}</span>
                </button>
              ))}
            </div>
            {dupGroup?.sizeMismatch && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
                同组资产体积差异超过 30%，可能不是同一套资产——删除前请先确认。
              </p>
            )}
            <button
              className="btn btn-outline-danger mt-2 w-full !bg-transparent"
              onClick={keepThisCopyOnly}
              title={`保留当前这份，其余副本移入回收站（二次确认，${undoGraceSuffix(undoGraceMs)}）`}
            >
              <IconTrash width={14} height={14} />
              保留这份，其余移入回收站
            </button>
          </div>
        )}

        {/* ── 分类（一级 / 二级，可点击指派）────────────────────────────
            2026-10 用户拍板：「材质的右侧栏这个地方是不显示风格的……直接就是显示一级分类、
            二级分类。如果它没有分类的话，用户在这个地方就可以直接快速地去创建分类。」
            所以本区块就落在原「风格（可多选）」的位置（风格区在材质大类下已被
            `showStyleBlock` 关掉，见上方注释）。

            指派**复用既有的 `CategoryPicker`**：面板里不新造第二个选择器 ——
            两级级联（`level1OptionsFor` / `level2OptionsFor`）、受控词表、
            hdri / other 的自由输入兜底、跨大类禁用、自绘浮层与 Esc/点外部收起，
            全部由那一个组件负责（`App.tsx` 全局只挂一份，由 store 的
            `openCategoryPicker` 驱动；这里只负责「把哪个资产交给它」）。
            写入走 store 既有的 `assignCategory`：DB + 磁盘目录 + 缩略图重生一次完成，
            中栏列表与左栏分类计数同源刷新，不在组件里拼 state。
            撤销：`CategoryPicker` 这条路本来就不发 5 秒撤销条（归类撤销只在拖拽归类
            `assignCategoryWithUndo` 那条链上），这里沿用现状，不新造。 */}
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-medium text-muted">分类</div>
          <div className="overflow-hidden rounded-slotgroup border border-soft-line">
            <CategoryRow
              label="一级分类"
              value={category1}
              disabled={deleted}
              onClick={() => openCategoryPicker([asset.id])}
            />
            <CategoryRow
              label="二级分类"
              value={category2}
              disabled={deleted}
              onClick={() => openCategoryPicker([asset.id])}
            />
          </div>
          {/* 提示只在「未分类 / 软删」两种需要解释的状态下出现：
              已分类的资产每行右侧已有「更改」，再挂一行说明只会把 300px 的面板撑吵。 */}
          {deleted ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              已删除的资产不能改分类，请先还原。
            </p>
          ) : !hasCategory ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              未分类：点击任意一行即可指派（先选一级，再选二级）。
            </p>
          ) : null}
        </div>

        {/* 风格（受控词表多选，与自由 tags 分离；06 §4.4-①）
            §3.4：已选 = accent-tint 蓝字 chip；「＋ 风格 / 标签」= 描边 ghost chip
            ⚠️ 材质大类（texture / material）**整块不渲染**：材质没有「风格」这个语义，
            那个位置换成了上面的「分类」区块（`showStyleBlock` 的判据见组件顶部）。 */}
        {showStyleBlock && (
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] font-medium text-muted">风格（可多选）</div>
            <div className="flex flex-wrap gap-1.5">
              {styleOptions.map((v) => {
                const active = assetStyles.includes(v)
                return (
                  <button
                    key={v}
                    className={active ? 'chip-accent transition' : 'chip-ghost'}
                    onClick={() => toggleStyle(v)}
                    title={active ? '移除该风格' : '添加该风格'}
                  >
                    {active ? '' : '＋ '}
                    {v}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 备注 */}
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-medium text-muted">备注</div>
          <textarea
            className="input !h-16 resize-none text-[13px]"
            placeholder="这个模型的用途、搭配建议…"
            value={asset.note}
            onChange={(e) => void updateAsset(asset.id, { note: e.target.value })}
          />
        </div>

        {/* 文件列表（§3.4）：按槽位分组；组头 26px bg-canvas 11px Semi Bold + 文件行 28px；
            「文件（N）」头部右侧「可单独拖出」提示 */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            {/* 走查 v0.2.2 B6#36（灰阶按已拍板）：「文件（N）」标题画布 2:137 是 #1F2937 = primary，
                此前用 text-muted → 归 primary。右侧提示保持 muted。 */}
            <span className="text-[11px] font-medium text-primary">文件（{asset.files.length}）</span>
            <span className="text-[10px] text-muted">可单独拖出</span>
          </div>
          {fileGroups.map((g) => (
            /* 走查 v0.2.2 B2#5 拍板：槽位组描边走第二档 --border-soft（画布 2:140 浅 #EEF1F4 / 深 #2A2A2D）；
               圆角走 --radius-slotgroup（画布 2:140 浅 r9 / 2:418 深 r7）。此前实现完全没有描边。 */
            <div key={g.key} className="mt-1.5 rounded-slotgroup border border-soft-line">
              <div className="flex h-[26px] items-center justify-between rounded-t-slotgroup bg-canvas px-2 text-[11px] font-semibold text-secondary">
                {g.label}
                <span className="text-[10px] font-normal text-muted">{g.files.length}</span>
              </div>
              {g.files.map((f) => (
                <FileRow key={f.rel} asset={asset} file={f} readOnly={deleted} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* HDR 预览入口（0.6.5）：仅 HDRI 资产、未软删时出现。
          放在底部操作行**正上方**而不是塞进那一行：右栏只有 300px，
          「打开所在文件夹 / 预览 HDR / 删除」挤一行会全部折行。 */}
      {asset.kind === 'hdri' && !deleted && (
        <div className="shrink-0 px-4 pt-3">
          <button
            className="btn w-full !bg-transparent"
            onClick={() => openHdrPreview(asset.id)}
            title="在内置渲染器中预览：中间一颗白球，拖动即可旋转 HDR 环境"
          >
            <IconHdr width={14} height={14} />
            预览 HDR
          </button>
        </div>
      )}

      {/* §3.4 底部操作行：打开所在文件夹（描边钮 flex-1）+ 删除（danger 描边钮 72px）
          删除改走 requestDelete（P0-16：先二次确认 + 5 秒撤销，不再一键删）

          C 线软删态换成：还原（主）+ 彻底删除（次）。
          「打开所在文件夹」在这里没有意义——`folder` 指向的原目录已经被搬走了。 */}
      <div className="flex shrink-0 gap-2 border-t border-line px-4 py-3">
        {deleted ? (
          <>
            <button
              className="btn btn-primary flex-1"
              onClick={() => void restoreAssets([asset.id])}
              title="把资产搬回原位置（原位置被占时自动追加序号）"
            >
              <IconRefresh width={14} height={14} />
              还原
            </button>
            <button
              className="btn btn-outline-danger w-[88px] shrink-0 !bg-transparent"
              onClick={() => setPurgeOpen(true)}
              title="彻底删除（进系统回收站，应用内不可还原）"
            >
              <IconTrash width={14} height={14} />
              彻底删除
            </button>
          </>
        ) : (
          <>
            <button
              className="btn flex-1 !bg-transparent"
              onClick={() => window.modvault.reveal(asset.folder)}
            >
              <IconFolder />
              打开所在文件夹
            </button>
            <button
              className="btn btn-outline-danger w-[72px] shrink-0 !bg-transparent"
              onClick={() => requestDelete([asset.id])}
              title={`删除（二次确认，${undoGraceSuffix(undoGraceMs)}）`}
            >
              <IconTrash width={14} height={14} />
              删除
            </button>
          </>
        )}
      </div>

      {purgeOpen && <PurgeConfirmDialog ids={[asset.id]} onClose={() => setPurgeOpen(false)} />}

      {/* 重复副本并排对比（回收站视图不渲染：那里的"保留这份"语义不成立） */}
      {compareOpen && !asset.deletedAt && (
        <DuplicateCompareDialog
          asset={asset}
          copies={dupCopies}
          sizeMismatch={dupGroup?.sizeMismatch ?? false}
          onKeep={(keepId) => {
            setCompareOpen(false)
            // 保留的是**某个副本**时，当前这条也会被移入回收站 → commitDelete 会把
            // selectedId 置空、右栏跳到空态。这里先把焦点切到保住的那份，用户视线不掉。
            // （保留当前这份时 keepId === asset.id，选中状态本来就不受影响，不做多余跳转）
            if (keepId !== asset.id) select(keepId)
            requestKeepOnly(keepId)
          }}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {coverPickerOpen && <CoverPicker asset={asset} onClose={() => setCoverPickerOpen(false)} />}
      {renderOpen && (
        <CustomRenderDialog asset={asset} slots={renderSlots} onClose={() => setRenderOpen(false)} />
      )}
    </aside>
  )
}

function KINDIcon({ kind }: { kind: AssetKind }) {
  const Icon = KIND_ICON[kind]
  return <Icon />
}
