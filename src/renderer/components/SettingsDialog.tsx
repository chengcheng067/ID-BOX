import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVault, type ZhimoReclassSummary } from '../store'
import { DISPOSAL_LABEL, SEVEN_ZIP_DOWNLOAD_URL } from '../../shared/types'
import type { AiClassifySettings, AliasRecord, ArchiveDisposal, MotionQuality } from '../../shared/types'
import { MOTION_PROFILES, MOTION_QUALITY_ORDER } from '../../shared/motionQuality'
import { aliasKeyOf } from '../../shared/aliasRules'
import { formatBytes } from '../../shared/format'
import { DIFF_LABEL, isReconcileClean, type DiffItem, type ReconcileReport } from '../logic/reconcile'
import {
  EMPTY_ALIASES,
  MAX_ALIASES,
  aliasIndexOf,
  mergeAliasRecords,
  newAliasId,
  parseAliasImport,
  serializeAliases,
  suggestAliasRecords,
  type AliasSuggestion
} from '../logic/aliasIndex'
import { RETENTION_OPTIONS } from '../logic/trashView'
// 删除撤销期（2026-10 用户需求）：三档选项与文案只从 `logic/graceText.ts` 取，
// 与删除链路（右键菜单 / 详情面板 / 确认弹窗）共用同一份口径，避免两处文案漂移。
import { UNDO_GRACE_OPTIONS } from '../logic/graceText'
import { normalizeUndoGraceMs } from '../../shared/undoGrace'
// 知末「站方分类重排」：候选筛选与备份前缀都用**同一个**纯逻辑模块，
// 与 `store.runZhimoCategoryReclass` 完全同一口径（渲染层不另写一套判定）。
// 备份前缀只从常量取（`'zhimo-reclass-'`），绝不在 UI 里手抄字符串 —— 抄一份就会漂移。
import { ZHIMO_RECLASS_BACKUP_PREFIX, isZhimoReclassCandidate } from '../logic/zhimoReclass'
// DEF-19-3：库目录被改过 / 搬过之后，老资产的 folder 不在新根下 → 主进程的
// probeSizes 守卫会一律拒绝（这是对的），但"整库尺寸补不上"必须在界面上有解释。
// 判据是纯函数，和分辨率浮层的就近提示**共用同一份**（两套判据必然漂移）。
import { planLibraryDrift, libraryDriftWarning } from '../logic/libraryDrift'
// 自动检查更新（2026-10 用户需求）：状态机单独一个模块 —— `store.ts` 正被并发改动，
// 更新检查只是「一个只读结论 + 一个进行中标志」，放进全局 store 只会扩大冲突面。
import {
  checkForUpdate,
  useUpdateChecking,
  useUpdateState
} from '../logic/updateState'
import { Modal } from './Modal'
import { useEscLayer } from '../logic/escLayer'
import { zClassForDepth } from '../logic/zStack'
import { IconCheck, IconRefresh } from '../icons'
import { UNCLASSIFIED } from '../../shared/taxonomy'
// 品牌资源（2026-10 用户要求「图标 logo 换一下」「关于页做上打赏和反馈」）：
// 三张图都由 `scripts/build-app-icon.cjs` 从 `resources/brand/` 的原图生成，
// 走 Vite 的 import（产物是哈希 URL），不放 public/ 也不内联 base64。
// 二维码是**裁好的 512×512**（码面已占 ~86%，四周自带 8% 白边）：
// 微信导出的原图里码面只占一半宽度，直接缩到 168px 会扫不出来。
import donateQr from '../assets/brand/donate-qr.png'
import contactQr from '../assets/brand/contact-qr.png'
import brandMark from '../assets/brand/mark.png'

// 自动检查在渲染进程入口 `main.tsx` 触发（不要依赖本文件的 import 时机：
// 设置弹窗一旦改成 `lazy()`，放在这里的模块副作用会静默失效）。

/**
 * 设置弹窗 tab（v0.8.1 整体重排，设计稿 `design-tmp/settings-redesign-v2.html`）。
 *
 * 信息架构的口径是**「这件事在什么时候起作用」**，不是「它属于哪个模块」：
 * - 外观：偏好（与素材无关的显示偏好）；
 * - 导入：东西**进来时**发生的事（处置 / 解压 / 命名 / 来源与封面）；
 * - 分类：进来**之后怎么归类**（导入时落库开关 + 存量重排 + 检查）；
 * - 库：库目录本身与索引维护（扫描 / 恢复 / 结构迁移 / 危险区）；
 * - 别名、数据与备份、关于同理。
 *
 * 变更要点：
 * ① 新增 `classify`（分类）——原来散在「导入」里的四个分类相关项 + 一致性检查收成一屏；
 * ② 删掉 `advanced`（高级）——它唯一的 7-Zip 行搬进「导入 · 解压」卡（带检测状态徽标）；
 * ③ 「库与分类」改名「库」（分类拆出去之后旧名字会误导）。
 *
 * ⚠️ 本轮只搬 JSX 与文案：所有 handler / state / IPC 调用 / 字段名一字未改。
 */
type SettingsTab = 'appearance' | 'import' | 'classify' | 'library' | 'alias' | 'data' | 'about'

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'import', label: '导入' },
  { key: 'classify', label: '分类' },
  // 原 label: '库与分类' —— 分类拆成独立 tab 之后，「库」只讲目录与索引
  { key: 'library', label: '库' },
  { key: 'alias', label: '别名' },
  { key: 'data', label: '数据与备份' },
  { key: 'about', label: '关于' }
]

/**
 * 左栏导航分组（设计稿：组标签 10.5px / 600 / letter-spacing .1em / `--text-muted`）。
 *
 * 分组只决定**呈现顺序**，`TABS` 仍是 tab 的唯一真源（key 顺序 = 内容/测试的基线）；
 * 两者不一致时以 `TABS` 为准 —— 这里只列 key，标签文字从 `TABS` 查。
 */
const TAB_GROUPS: { label: string; keys: SettingsTab[] }[] = [
  { label: '偏好', keys: ['appearance'] },
  { label: '素材', keys: ['import', 'classify', 'library', 'alias'] },
  { label: '数据', keys: ['data'] },
  { label: '其他', keys: ['about'] }
]

/** 页头副标题（设计稿逐屏文案，12px / `--text-tertiary`） */
const TAB_SUB: Record<SettingsTab, string> = {
  appearance: '主题、动效、侧栏显示',
  import: '压缩包、解压、命名、来源与封面',
  classify: '导入后怎么归类，以及存量怎么重排',
  library: '库目录、索引维护、结构迁移',
  alias: '把口语 / 英文词映射到分类',
  data: '删除、缓存、日志与迁移',
  about: '版本、更新与反馈'
}

/**
 * 反馈卡里的 GitHub Issue 入口。
 *
 * 走**既有** `window.modvault.openExternal`（preload 已接 `shell:openExternal`，
 * 主进程侧有协议白名单），不新开桥、不改 shared/types。
 */
const GITHUB_ISSUES_URL = 'https://github.com/chengcheng067/ID-BOX/issues'

/**
 * 分段控件的两个 class 片段（设计语言「② 分段控件」）。
 *
 * 为什么不做成 `<Segmented>` 组件：四个调用点（压缩包处置 / 动效 / 撤销期 / 保留期）
 * 的取值类型、默认标记、`onChange` 语义各不相同，抽成组件反而要塞一堆 props；
 * 更重要的一点 —— 设置页的源码守卫按 tab 统计按钮数（防搬漏），
 * 把 onClick 藏进组件会让"这个 tab 有几个可点项"从源码里读不出来。
 * 这里只共享**样式**，每个调用点自己 map、自己写 onClick。
 */
const SEG_GROUP_CLASS = 'inline-flex items-center gap-0.5 rounded-[9px] bg-pill p-0.5'

/** 单个分段项的样式（选中 = 白/深色浮起底 + accent 文字 + 轻投影） */
const segItemClass = (active: boolean): string =>
  `inline-flex items-center gap-1.5 rounded-[7px] px-3 py-[5px] text-[12px] transition ${
    active
      ? 'bg-seg-active font-medium text-accent-text shadow-sm'
      : 'text-secondary hover:bg-elevated/60'
  }`

/** 三档处置的展示顺序：回收站（默认）→ 彻底删除 → 保留（§3.6 单选卡顺序） */
const DISPOSAL_ORDER: ArchiveDisposal[] = ['recycle', 'delete', 'keep']

/**
 * 动效性能三档的展示顺序：流畅 → 均衡 → 极致（代价从左到右递增）。
 * 取值 / 文案 / 渲染参数全部来自 `shared/motionQuality.ts`，这里只决定横排顺序。
 */
const MOTION_ORDER: MotionQuality[] = [...MOTION_QUALITY_ORDER]

/** 三档单选卡的副文案（§3.6 截图口径） */
const DISPOSAL_HINT: Record<ArchiveDisposal, string> = {
  recycle: '定期清理回收站即可',
  delete: '立即释放磁盘空间，不可恢复',
  keep: '占双份空间，适合尚未整理定的素材'
}

/**
 * 「删除保留期」四档在分段控件里的**短标签**。
 *
 * `RETENTION_OPTIONS` 的 `label` 是给竖排单选卡写的（「直接进系统回收站」有 8 个字），
 * 塞进一行右侧的分段控件会撑破版面。这里只做**显示缩写**：完整 label + hint
 * 仍挂在按钮的 `title` 上，取值与文案真源仍是 `RETENTION_OPTIONS`（不另写一套语义）。
 */
const RETENTION_SHORT: Record<string, string> = {
  '5d': '5 天',
  '10d': '10 天',
  '30d': '30 天',
  recycle: '系统回收站'
}

function Toggle({
  checked,
  onChange,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  /**
   * 置灰**但不改值**（docs/24 §5.5 子开关：总开关关闭时子偏好必须原样保留，
   * 下次打开总开关时用户设置还在）。`disabled` 的按钮不可聚焦、不响应点击，
   * 但仍渲染 `aria-checked`，读屏仍能读出当前值。
   */
  disabled?: boolean
}) {
  return (
    <button
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${
        checked ? 'bg-accent' : 'bg-elevated'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  )
}

/**
 * 复选框的视觉标记（16×16 方块）。
 *
 * 沿用仓库既有语言，不另造一套：
 * - 未勾 = §3.6 单选圆点 `RadioDot` 的同一档（`h-4 w-4` + `border-2 border-line`）；
 *   形状用方块而不是圆 —— 圆已经被单选语义占用，方块对应 §3.3 选中徽章。
 * - 已勾 = §3.3 `.check-badge` / `AssetGrid.SelectBox` 方块档：accent 底 + 白勾。
 *
 * 尺寸取 16×16 而不是 22×22：22 是网格卡片的选中徽章，放进设置页 12px 文字的行内
 * 会过重；16 与 `RadioDot` 同档，正好配 `gap-2` 的行密度。
 */
function CheckMark({ checked, className = '' }: { checked: boolean; className?: string }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-2 transition ${
        checked ? 'border-accent bg-accent text-white' : 'border-line text-transparent'
      } ${className}`}
    >
      {checked && <IconCheck width={10} height={10} strokeWidth={3} />}
    </span>
  )
}

/**
 * 自绘复选框行（用户 2026-10 拍板：「不要系统的默认控件」）。
 *
 * 为什么用 `<button>` 而不是 `<span>` + `tabIndex`：button 原生可聚焦、Enter/Space
 * 直接切换，不需要再手写按键；`role="checkbox"` + `aria-checked` 保住复选框语义，
 * 读屏仍读得出当前值。整行可点（不靠 `<label>` 的隐式关联：label 包 button
 * 点了不会切换）。`disabled` 走 `aria-disabled`：属性 disabled 的 button 不可聚焦，
 * 键盘用户会整行失踪 —— 这里置灰但仍可聚焦（与 `Toggle` 的「置灰不改值」口径一致）。
 *
 * ⚠️ 只换呈现、不改语义：每个调用点的 `onChange(next)` 与原 `e.target.checked`
 * 完全等价（别名建议 `setPicked` / 强制重扫 `setForceAck` / 对账三个 apply 勾选）。
 */
function CheckRow({
  checked,
  onChange,
  disabled = false,
  align = 'center',
  className = '',
  title,
  children
}: {
  checked: boolean
  /** 新值（原 `e.target.checked` 的等价物） */
  onChange: (next: boolean) => void
  /** 置灰但不改值：仍然可聚焦、仍可读出 `aria-checked` */
  disabled?: boolean
  /** 单行用 `items-center`；多行文案要贴第一行对齐 → `items-start` */
  align?: 'center' | 'start'
  /** 调用点原有的排版（`mt-3` / `py-0.5` / `leading-relaxed`…） */
  className?: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      title={title}
      onClick={() => {
        if (disabled) return
        onChange(!checked)
      }}
      className={`flex w-full gap-2 text-[12px] text-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 ${
        align === 'start' ? 'items-start' : 'items-center'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${className}`}
    >
      <CheckMark checked={checked} className={align === 'start' ? 'mt-0.5' : ''} />
      {children}
    </button>
  )
}

/**
 * 设置页的一行（**布局实现**，设计语言「标题 + 一行摘要 + 右侧控件」）。
 *
 * 规格来自 `design-tmp/settings-redesign-v2.html`：
 * - 行高节奏：**单行 59 / 双行 77**（v0.8.1 尺寸收敛后实测值）。
 *   算式：`py-2.5` 10+10 + 标题 13.5px×`leading-[1.25]`≈17 + `mt-1` 4 + 摘要 12px×1.5=18；
 *   设计稿标的 54/68 是按 `line-height: normal` 估的，Tailwind 的 1.5 会把标题撑到 20px，
 *   所以这里把上下 padding 从 12 收到 10、标题行高压到 1.25，把 66 拉回 59（仍在 54–60 区间）；
 * - 行间 1px `--border-soft`，**卡内首行无上分隔**（`first:border-t-0`：`SettingsCard`
 *   把 children 包进一个容器，所以"首行"永远是该容器的第一个 child）；
 * - 右侧操作区不换行（`flex-nowrap` 由 `flex` 默认值给出，`shrink-0` 锁死宽度）；
 * - 摘要**只写一行**（约 40 汉字），超出的长说明必须进 `SettingsCard` 的 `note`。
 *
 * `notice` 保留原语义：说明下方可行动的警示条（DEF-19-3 库目录漂移），
 * 它比 `desc` 的常驻灰字更需要被一眼看到。
 *
 * ⚠️ 这个函数名是源码守卫的锚点（`zhimoCoverWiring.test.ts` 用它切 `Toggle` 段），
 * 改名会打断那份守卫，所以新样式在 **Row 本体**上改，而不是另起一个组件再弃用它。
 */
function Row({
  title,
  desc,
  notice,
  children
}: {
  title: string
  /** 摘要：只写一行；需要换行的长说明走 `SettingsCard.note` */
  desc?: React.ReactNode
  notice?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-soft-line py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium leading-[1.25] text-primary">{title}</div>
        {desc && <div className="mt-1 text-[12px] leading-[1.5] text-tertiary">{desc}</div>}
        {notice}
      </div>
      {children && (
        <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">{children}</div>
      )}
    </div>
  )
}

/**
 * 设计语言里的「设置行」：`Row` 的语义化门面。
 *
 * 与 `Row` 的唯一区别是 prop 名 —— 操作统一进 `actions`（读代码时一眼看出
 * "这一行右侧有什么可点的"），`desc` 的类型放宽到 ReactNode（路径 / 徽标要内联）。
 * 两个名字并存不是冗余：`Row` 是布局实现 + 守卫锚点，`SettingsRow` 是新 tab 的写法。
 */
function SettingsRow({
  title,
  desc,
  notice,
  actions
}: {
  title: string
  desc?: React.ReactNode
  notice?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <Row title={title} desc={desc} notice={notice}>
      {actions}
    </Row>
  )
}

/**
 * 设置卡片：**一张卡 = 一个心智单元**（设计语言第一条）。
 *
 * 规格（design-tmp 第 8 帧 + 各 tab 帧）：白卡 `--surface-card` + 1px `--border-panel`
 * + 圆角 12 + 内边距「上 5 / 左右 18」；标题 11/600/letter-spacing .08em/`--text-muted`
 * 上内边距 11。
 *
 * `danger`：危险区独立成卡（红描边 + 红标题）。色值走既有 `--danger` / `--danger-tint`
 * 而不是设计稿里那两个浅色十六进制 —— 深色主题下 `#fffafa` 会变成一块刺眼白，
 * 而 `--danger-tint` 两套主题各有一份（浅 `#fef1f0` ≈ 设计稿，深 `#2a1517`）。
 *
 * `note`：卡底通栏浅灰条，承载原来那些 3–4 行的长说明（`--bg-canvas` 底 + 上边框
 * `--border-soft` + 11.5px/1.7 `--text-tertiary`）；用左右负边距抵消卡片内边距，
 * 底圆角对齐卡片，视觉上就是"卡片的下半截"。
 *
 * ⚠️ 两条规则别搞混：**note 不限行数**（它就是长说明的容器，折 3–4 行是设计意图）；
 * **行摘要限 1 行**（超过就下沉进 note，见 `Row` 的 `desc`）。
 */
function SettingsCard({
  title,
  danger = false,
  note,
  children
}: {
  title?: string
  /** 危险区：描边/标题走 danger 语义色（红色只允许出现在这里） */
  danger?: boolean
  /** 卡底通栏 note：承载超出「一行摘要」的长说明 */
  note?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      className={`rounded-xl border px-[18px] pb-[5px] pt-[5px] ${
        danger ? 'border-danger/40 bg-danger-tint' : 'border-panel-line bg-card'
      }`}
    >
      {title && (
        <div
          className={`pb-px pl-0 pr-0 pt-[11px] text-[11px] font-semibold tracking-[0.08em] ${
            danger ? 'text-danger' : 'text-muted'
          }`}
        >
          {title}
        </div>
      )}
      <div>{children}</div>
      {note && (
        <div className="-mx-[18px] -mb-[5px] mt-0.5 rounded-b-xl border-t border-soft-line bg-canvas px-[18px] py-[9px] text-[11.5px] leading-[1.7] text-tertiary">
          {note}
        </div>
      )}
    </section>
  )
}

/**
 * 状态徽标（设计语言「⑤ 状态徽标」）：10.5px 胶囊。
 *
 * 三档色调全部复用既有 token：
 * - `ok` → `--success`（绿，正常/已完成）；
 * - `warn` → `--danger` 系（仓库**没有**橙色 token；「7-Zip 未找到」是能力缺失，
 *   按"不新增颜色"的纪律取最近的既有语义色，而不是硬编码 `#b26a00`）；
 * - `muted` → `--tint-neutral`（灰，中性信息/暂无）。
 */
function StatusBadge({
  tone = 'muted',
  title,
  children
}: {
  tone?: 'ok' | 'warn' | 'muted'
  title?: string
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'ok'
      ? 'bg-success/15 text-success'
      : tone === 'warn'
        ? 'bg-danger-tint text-danger'
        : 'bg-neutral-tint text-neutral-tint-text'
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-full px-[7px] py-[1.5px] text-[10.5px] font-medium ${toneClass}`}
    >
      {children}
    </span>
  )
}

/**
 * 内容区页头（设计语言：标题 17/600 + 副标题 12/`--text-tertiary`，右侧仍是现有 ✕）。
 *
 * 与旧页头的差别：从"固定 48px 高 + 下边框"改成"22/32/14 的内边距 + 无下边框"，
 * 让页面看起来是「画布 + 卡片」而不是「工具条 + 表单」。✕ 按钮的实现原样搬过来。
 */
function PageHeader({
  title,
  sub,
  onClose,
  saved = false
}: {
  title: string
  sub: string
  onClose: () => void
  /** 任一设置项刚写库时的「已保存」提示（1.2 秒自消失，见 `flash()`） */
  saved?: boolean
}) {
  return (
    <header className="flex shrink-0 items-start justify-between px-8 pb-[14px] pt-[22px]">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold text-primary">{title}</h2>
        <p className="mt-[5px] flex items-center gap-2 text-[12px] text-tertiary">
          <span>{sub}</span>
          {saved && <span className="text-success">已保存</span>}
        </p>
      </div>
      <button className="btn btn-ghost !p-1.5" onClick={onClose} title="关闭">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </header>
  )
}

/**
 * 关于页「赞赏支持 / 反馈建议」卡片（v0.8.1：宽度等分 + 二维码统一 146×146）。
 *
 * 二维码的可扫性是这个组件唯一的硬要求，所以容器有三层保护：
 * ① 外层**白底**（`bg-white`）——深色主题下黑白码直接贴在 `--surface-card` 上扫不出来；
 * ② `p-[13px]`（13px）内边距 + 图片自带的 8% 白边（裁图时补的静区）= 两层留白；
 * ③ `object-contain` + 固定 146×146：只等比缩放，绝不拉伸（拉伸会破坏模块栅格）。
 *
 * 卡片外壳直接用 `SettingsCard`（同一套白卡/标题规格），不再自己拼 ring + rounded；
 * `footer` 是反馈卡独有的 GitHub Issue 入口（赞赏卡不传 = 不渲染）。
 */
function SupportCard({
  title,
  qrSrc,
  qrAlt,
  caption,
  footer
}: {
  title: string
  qrSrc: string
  qrAlt: string
  caption: string
  footer?: React.ReactNode
}) {
  return (
    <SettingsCard title={title}>
      <div className="my-[9px] flex items-center justify-center rounded-xl border border-soft-line bg-white p-[13px]">
        <img
          src={qrSrc}
          alt={qrAlt}
          draggable={false}
          className="h-[146px] w-[146px] object-contain"
        />
      </div>
      <p className="text-[11.5px] leading-[1.7] text-tertiary">{caption}</p>
      {footer && <div className="pb-[9px] pt-[9px]">{footer}</div>}
    </SettingsCard>
  )
}

/**
 * 主题卡迷你界面预览（v0.8.1：缩略图 46px 高，对应设计稿 `.sw-thumb`）。
 *
 * 色值仍是规范 §1 的 token **原值**（这里是"画一张图"，不是主题本身，
 * 所以必须写死两套色；跟随主题变量会导致浅色缩略图在深色下变黑）。
 * 尺寸从 104px 收到 46px：选中态改由外层按钮的 accent 描边 + 外环表达，
 * 缩略图不再需要"画一整个界面"来说服用户。
 */
function ThemePreview({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  if (mode === 'light') {
    return (
      <div className="flex h-[46px] w-full overflow-hidden bg-[#F8FAFC]">
        <div className="h-full w-2.5 bg-[#F1F5F9]" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
          <div className="h-1.5 w-full rounded-sm bg-[#FFFFFF]" />
          <div className="flex flex-1 gap-1">
            <div className="h-full w-4 rounded-sm bg-[#E1EFFF]" />
            <div className="h-full flex-1 rounded-sm bg-[#FFFFFF]" />
            <div className="h-full w-3 rounded-sm bg-[#007AFF]" />
          </div>
        </div>
      </div>
    )
  }
  if (mode === 'system') {
    // 跟随系统：左半浅 / 右半深，一眼看出「两套都跟随」
    return (
      <div className="flex h-[46px] w-full overflow-hidden">
        <div className="flex h-full w-1/2 flex-col gap-1 bg-[#F8FAFC] p-1.5">
          <div className="h-1.5 w-full rounded-sm bg-[#FFFFFF]" />
          <div className="flex-1 rounded-sm bg-[#FFFFFF]" />
        </div>
        <div className="flex h-full w-1/2 flex-col gap-1 bg-[#111113] p-1.5">
          <div className="h-1.5 w-full rounded-sm bg-[#1C1C1E]" />
          <div className="flex-1 rounded-sm bg-[#1C1C1E]" />
        </div>
      </div>
    )
  }
  // 只剩浅色以外的分支 = 深色
  return (
    <div className="flex h-[46px] w-full overflow-hidden bg-[#111113]">
      <div className="h-full w-2.5 bg-[#161618]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
        <div className="h-1.5 w-full rounded-sm bg-[#1C1C1E]" />
        <div className="flex flex-1 gap-1">
          <div className="h-full w-4 rounded-sm bg-[#1E2A38]" />
          <div className="h-full flex-1 rounded-sm bg-[#1C1C1E]" />
          <div className="h-full w-3 rounded-sm bg-[#0A84FF]" />
        </div>
      </div>
    </div>
  )
}

/**
 * 一条别名的可编辑行（0.6.0 §3.3）。
 *
 * 交互纪律：
 * - **失焦保存**（不是每次按键）：每敲一个字符写一次 settings.json 会把主进程打满；
 * - 提交时 trim，空串 = 放弃编辑（回填原值）—— 空别名会让标题变成空白，绝不允许；
 * - 值没变就不写库（避免无意义的 settings 落盘导致全应用重建别名索引）。
 */
function AliasRow({
  record,
  onSave,
  onDelete
}: {
  record: AliasRecord
  onSave: (name: string) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(record.name)
  /**
   * Esc 回滚的「别保存」标记。
   *
   * blur 是**同步派发**的：先 `setDraft(record.name)` 再 `blur()` 时，`commit` 这次
   * 仍然闭包着编辑后的 `draft` → 会把用户刚想撤回的值存下去。所以回滚必须靠标记，
   * 而不是靠"改完 state 再失焦"（原始写法实际上把 Esc 变成了保存）。
   */
  const revertingRef = useRef(false)
  // 外部改动（导入 / 采纳建议 / 删除同名项）要跟随；依赖 record.name 而不是整对象，避免无谓刷新
  useEffect(() => {
    setDraft(record.name)
  }, [record.id, record.name])

  const commit = () => {
    if (revertingRef.current) {
      revertingRef.current = false
      setDraft(record.name)
      return
    }
    const next = draft.trim()
    if (!next || next === record.name) {
      setDraft(record.name)
      return
    }
    onSave(next)
  }

  /** 归一化 key（脏数据兜底：归一化后为空就显示原 key，至少别显示空白） */
  const normalizedKey = aliasKeyOf(record.key) || record.key

  return (
    <div className="flex items-center gap-2 border-b border-line/60 px-2 py-1.5 last:border-0">
      <code
        className="min-w-0 flex-1 truncate rounded bg-canvas px-1.5 py-0.5 text-[11px] text-secondary"
        title={`原名：${record.key}\n归一化 key：${normalizedKey}`}
      >
        {normalizedKey}
      </code>
      {record.scope === 'asset' && (
        <span className="badge shrink-0" title="只对这一条资产生效（资产级覆盖）">
          单资产
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted">→</span>
      <input
        className="input !w-40 shrink-0 !py-0.5 text-xs"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // 这里的 Esc 语义是「回滚这条别名的草稿」，**不是**关弹窗：
          // 草稿只在失焦时才保存，按 Esc 走人等于放弃修改 —— 若让 `Modal` 吃掉 Esc，
          // 用户本想撤回一格输入，结果整个设置弹窗被关掉。
          // `data-esc-own` 让 Esc 层的捕获监听（useEscLayer，见 logic/escLayer.ts）
          // 对这一格放行；这里的 stopPropagation 再把它拦在 App 的全局 Esc 之前。
          if (e.key === 'Escape') {
            revertingRef.current = true
            setDraft(record.name)
            // 回滚做完后把按键按死在输入框这一层（0.7.6-ESC-01 的第三道保险）：
            // `useEscLayer` 见到 `data-esc-own` 只会**放行**（它绝不能 stop，否则这一格
            // 的草稿回滚就收不到按键了），放行之后事件会继续冒泡到 App 的 window 冒泡监听。
            // 本层 stop 之后，App 连 `decideEsc` 都不会进 —— 不依赖"层栈非空"这个前提。
            // 必须在 blur() 之前调：blur 是同步派发的，会把 React 合成事件提前收尾。
            e.stopPropagation()
            e.currentTarget.blur()
          }
        }}
        data-esc-own
        title="显示名：失焦即保存；只改界面显示，磁盘文件名不动"
      />
      <button
        className="shrink-0 rounded p-1 text-muted transition hover:bg-elevated hover:text-danger"
        onClick={onDelete}
        title="删除这条别名（不改任何磁盘文件）"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

/**
 * 设置 · 别名 tab（0.6.0 §3.3）。
 *
 * 五个能力，全部**只写 `settings.aliases`**，一个字都不落到磁盘文件上：
 * ① 表格增删改（失焦保存）；② 新增一条；③ 导入 / 导出 JSON；
 * ④ 「采纳建议」（`shared/aliasSuggest` 的词表建议，勾选后才写）；⑤ 500 条上限。
 *
 * 建议**绝不自动写库**：必须先点「采纳建议」生成、再勾选、再点「加入选中项」。
 * 材料名是用户资产，写错比不写更糟（docs/20 §10）。
 */
function AliasTab() {
  const aliases = useVault((s) => s.settings?.aliases) ?? EMPTY_ALIASES
  const assets = useVault((s) => s.assets)
  const saveSettings = useVault((s) => s.saveSettings)

  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  const [suggestions, setSuggestions] = useState<AliasSuggestion[]>([])
  /** 已勾选的建议 key（用归一化 key 做标识，避免 index 漂移） */
  const [picked, setPicked] = useState<string[]>([])
  /** 一行反馈（导入 N 条 / 跳过 M 条 / 上限提示）——常驻 tab 内，不走全局 notice */
  const [message, setMessage] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const full = aliases.length >= MAX_ALIASES
  const aliasIndex = aliasIndexOf(aliases)
  const persist = (next: AliasRecord[]): void => {
    void saveSettings({ aliases: next })
  }

  /** 新增一条：`key` 归一化后如果已存在 → 覆盖同名条目的显示名（不产生重复行） */
  const addOne = () => {
    const key = aliasKeyOf(newKey)
    const name = newName.trim()
    if (!key) {
      setMessage('请先填写原名（不能只有空格 / 符号）')
      return
    }
    if (!name) {
      setMessage('请填写要显示的名字')
      return
    }
    if (full) {
      setMessage(`别名已达上限 ${MAX_ALIASES} 条，请先删除不用的条目`)
      return
    }
    const merged = mergeAliasRecords(aliases, [
      { id: newAliasId(), scope: 'key', key, name, createdAt: Date.now() }
    ])
    persist(merged.records)
    setNewKey('')
    setNewName('')
    setMessage(merged.replaced > 0 ? '已更新同名别名的显示名' : null)
  }

  /** 改一条 → 只替换该记录（顺带抬高 `createdAt`，同键多条时让这次编辑生效） */
  const renameOne = (record: AliasRecord, name: string) => {
    persist(aliases.map((r) => (r.id === record.id ? { ...r, name, createdAt: Date.now() } : r)))
    setMessage(null)
  }

  const removeOne = (id: string) => {
    persist(aliases.filter((r) => r.id !== id))
    setMessage(null)
  }

  /** 生成建议（最多 10 条）。已有别名的 key 会被跳过，不会把用户自己的名字盖掉 */
  const refreshSuggestions = () => {
    const list = suggestAliasRecords(assets, aliasIndex, 10)
    setSuggestions(list)
    setPicked(list.map((s) => s.key))
    setMessage(
      list.length === 0
        ? '没有可采纳的建议：词表认不出这些资产名，或它们已经有别名了'
        : `按当前资产名生成 ${list.length} 条建议，勾选后才会写入`
    )
  }

  /** 采纳勾选的建议（唯一写入点；按钮在下面，没有任何自动写入路径） */
  const applySuggestions = () => {
    const chosen = suggestions.filter((s) => picked.includes(s.key))
    if (chosen.length === 0) return
    const now = Date.now()
    const merged = mergeAliasRecords(
      aliases,
      chosen.map((s, i) => ({
        id: newAliasId(),
        scope: 'key' as const,
        key: s.key,
        name: s.name,
        createdAt: now + i
      }))
    )
    persist(merged.records)
    setMessage(
      `已加入 ${merged.added + merged.replaced} 条${
        merged.dropped > 0 ? `，${merged.dropped} 条因上限未加入` : ''
      }`
    )
    setSuggestions([])
    setPicked([])
  }

  /** 导出：`[{key,name}]`（与导入格式互逆；不带 id / createdAt） */
  const exportJson = () => {
    const blob = new Blob([serializeAliases(aliases)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'idbox-aliases.json'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setMessage(`已导出 ${aliases.length} 条（idbox-aliases.json）`)
  }

  /** 导入：脏行只跳过，整份文件坏掉才报错 */
  const importJson = async (file: File) => {
    let text = ''
    try {
      text = await file.text()
    } catch {
      setMessage('导入失败：读取文件失败，请重试')
      return
    }
    const parsed = parseAliasImport(text, Date.now())
    if (parsed.error) {
      setMessage(parsed.error)
      return
    }
    const merged = mergeAliasRecords(aliases, parsed.records)
    persist(merged.records)
    setMessage(`导入 ${merged.added + merged.replaced} 条，跳过 ${parsed.skipped + merged.dropped} 条`)
  }

  return (
    <div className="flex flex-col gap-[13px]">
      <SettingsCard
        title="别名映射表"
        note={
          <>
            左边是归一化后的原名（大小写 / 空格 / 下划线 / 「4K」尾巴 / 知末 ID 都会被抹平），
            一条词典对所有同名资产生效；右侧「显示名」失焦即保存。共 {aliases.length} /{' '}
            {MAX_ALIASES} 条。别名只参与「自动分类」匹配，不进落盘路径。
          </>
        }
      >
        <SettingsRow
          title="只改显示名"
          desc="别名只改软件里显示的名字，磁盘上的文件名不动。"
        />

        {/* ── 表格：原名 → 显示名（逐行可编辑 / 可删） ───────────────── */}
        <div className="mb-3 overflow-hidden rounded-btn border border-line">
        <div className="flex items-center gap-2 border-b border-line bg-canvas/60 px-2 py-1.5 text-[10px] text-muted">
          <span className="min-w-0 flex-1">原名（归一化后的 key）</span>
          <span className="w-4 shrink-0" />
          <span className="w-40 shrink-0">显示名</span>
          <span className="w-6 shrink-0" />
        </div>
        {aliases.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">
            还没有别名。下面新增一条，或点「采纳建议」看看词表能不能认出这些资产名。
          </div>
        ) : (
          aliases.map((r) => (
            <AliasRow
              key={r.id}
              record={r}
              onSave={(name) => renameOne(r, name)}
              onDelete={() => removeOne(r.id)}
            />
          ))
        )}
      </div>

      {/* ── 新增一条 ─────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] text-muted">
          原名
          <input
            className="input !py-1 text-xs"
            value={newKey}
            spellCheck={false}
            placeholder="Polished_Concrete / 石材 4K"
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addOne()
            }}
          />
        </label>
        <label className="flex w-40 shrink-0 flex-col gap-1 text-[10px] text-muted">
          显示名
          <input
            className="input !py-1 text-xs"
            value={newName}
            placeholder="抛光混凝土"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addOne()
            }}
          />
        </label>
        <button
          className="btn btn-primary !py-1 text-xs"
          disabled={full}
          onClick={addOne}
          title={full ? `已达上限 ${MAX_ALIASES} 条，请先删除不用的条目` : '新增一条别名（只影响显示）'}
        >
          ＋ 新增一条
        </button>
      </div>
      {full && (
        <p className="mt-1 text-[10px] leading-relaxed text-danger">
          别名已达上限 {MAX_ALIASES} 条，新增已禁用；请先删除不用的条目。
        </p>
      )}

      {/* ── 导入 / 导出 / 采纳建议 ───────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="btn !py-1 text-xs"
          disabled={aliases.length === 0}
          onClick={exportJson}
          title="导出当前别名表为 [{key,name}] JSON（可换机导入）"
        >
          导出 JSON
        </button>
        <button
          className="btn !py-1 text-xs"
          onClick={() => fileRef.current?.click()}
          title="导入 [{key,name}] JSON；非法行会被跳过"
        >
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0]
            // 清空 value：否则连着选同一个文件不会再触发 change
            e.currentTarget.value = ''
            if (file) void importJson(file)
          }}
        />
        <button
          className="btn !py-1 text-xs"
          onClick={refreshSuggestions}
          title="按当前资产名用内置分类词表生成建议；只是建议，勾选后才写入"
        >
          采纳建议
        </button>
        {message && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-secondary" title={message}>
            {message}
          </span>
        )}
      </div>

      {/* ── 建议列表（勾选 → 一键加入；绝不自动写库） ──────────────── */}
      {suggestions.length > 0 && (
        <div className="mt-3 rounded-btn border border-line bg-canvas/40 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium text-primary">
              建议（{suggestions.length}）
            </span>
            <button
              className="text-[11px] text-muted transition hover:text-primary"
              onClick={() => {
                setSuggestions([])
                setPicked([])
              }}
            >
              收起
            </button>
          </div>
          <p className="mb-1.5 text-[10px] leading-relaxed text-muted">
            建议来自内置分类词表，只在你勾选并点「加入选中项」后才写入。
          </p>
          <div className="max-h-40 overflow-auto">
            {suggestions.map((s) => (
              <CheckRow
                key={s.key}
                checked={picked.includes(s.key)}
                onChange={(next) =>
                  setPicked((prev) =>
                    next ? [...prev, s.key] : prev.filter((k) => k !== s.key)
                  )
                }
                className="py-0.5"
              >
                <span className="min-w-0 flex-1 truncate text-muted" title={s.sourceName}>
                  {s.sourceName}
                </span>
                <span className="shrink-0 text-[11px] text-muted">→</span>
                <span className="w-24 shrink-0 truncate font-medium text-primary" title={s.name}>
                  {s.name}
                </span>
              </CheckRow>
            ))}
          </div>
          <button
            className="btn btn-primary mt-2 !py-1 text-xs"
            disabled={picked.length === 0}
            onClick={applySuggestions}
            title={picked.length === 0 ? '请先勾选要加入的建议' : '把勾选的建议写入别名表'}
          >
            加入选中项（{picked.length}）
          </button>
        </div>
      )}
      </SettingsCard>
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useVault((s) => s.settings)
  const saveSettings = useVault((s) => s.saveSettings)
  const rescan = useVault((s) => s.rescan)
  /**
   * DEF-19-3：库目录漂移体检（只读派生数据）。
   *
   * 必须用**全库 assets**（不是 `useVisibleAssets()`）：分辨率浮层那边已经按筛选裁过，
   * 而这里要回答的是"索引里有多少条路径已经不在当前库目录下"，与筛选无关。
   * 纯函数，`assets` / `libraryDir` 不变就不会重算。
   */
  const allAssets = useVault((s) => s.assets)
  const libraryDrift = useMemo(
    () => planLibraryDrift(allAssets, settings?.libraryDir ?? ''),
    [allAssets, settings?.libraryDir]
  )
  /**
   * 警示条内容（`null` = 整块不渲染）。文案与"何时显示"都在纯函数里裁决，
   * 单测能直接证明「folder 旧根 + libraryDir 新根 → 提示出现」。
   */
  const driftWarning = libraryDriftWarning(libraryDrift)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [version, setVersion] = useState('')
  // 自动检查更新（关于页）：结论 + 进行中标志都来自 logic/updateState.ts 的模块级 store。
  // 启动自动检查已在文件顶部触发（模块级），这里只负责渲染与手动重试。
  const updateInfo = useUpdateState()
  const updateChecking = useUpdateChecking()
  /**
   * 内容区底部「还有内容」渐隐条（2026-10-21 走查 P2⑦）。
   *
   * 现象：设置弹窗固定 560px 高，数据/高级 tab 的内容比可视区高，最后一行正好被
   * 下边缘切一半，而右侧滚动条在 Windows 上默认是**悬停才显形**的浮层式 ——
   * 用户看不出「下面还有」。这里在真的滚到底之前，底部压一条从卡片底色到透明的
   * 渐隐，滚动条看不见时也有"内容继续"的视觉信号；滚到底就撤掉（否则会误以为还有）。
   *
   * 量高度必须在内容变化后重算 —— 内容高度变化不会触发 scroll 事件（切 tab、
   * 异步读到的缓存统计都会改高度），所以用 ResizeObserver 盯内容块。
   */
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [tabHasMore, setTabHasMore] = useState(false)

  const syncTabOverflow = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    // 留 2px 容差：亚像素布局会让差值停在 0.5 这种数上，否则滚到底了提示条还挂着
    setTabHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2)
  }, [])

  useEffect(() => {
    const el = tabScrollRef.current
    if (!el) return
    // 切 tab 必须回到顶部：滚动容器是**同一个 DOM**（只换 children），不重置的话
    // 新 tab 会继承上一个 tab 的 scrollTop（被浏览器夹到自己的最大值）——用户点「库与分类」
    // 直接落在中段，而且底部渐隐条算出来是「已到底」→ 不显示，等于把提示也弄丢了。
    el.scrollTop = 0
    syncTabOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncTabOverflow)
    // 同时盯滚动容器（自身尺寸变化）与内容块（内容高度变化）
    const content = el.firstElementChild
    if (content) ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tab, syncTabOverflow])
  // 重新扫描（§4-7：只放设置·导入 tab，顶栏不占位）
  const [rescanBusy, setRescanBusy] = useState(false)
  // T07：遗留布局迁移（03 §4.4）
  const legacyLayoutCount = useVault((s) => s.legacyLayoutCount)
  const migrateLegacyLayout = useVault((s) => s.migrateLegacyLayout)
  const [migOpen, setMigOpen] = useState(false)
  const [migBusy, setMigBusy] = useState(false)
  const [migResult, setMigResult] = useState<{ moved: number; failed: number } | null>(null)
  const [sevenZip, setSevenZip] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /**
   * 命名模板草稿（0.6.0 批量重命名，docs/22 §3.4）。
   *
   * `null` = 未编辑（显示 `settings.renameTemplate`）。用草稿而不是每次按键都写
   * settings：模板是文本，逐字符落盘会把 settings.json 写成几十次。
   * 失焦 / 回车时才提交；空串表示"清掉草稿"，不覆盖已保存的默认值。
   */
  const [tplDraft, setTplDraft] = useState<string | null>(null)
  // 缩略图缓存统计（数量 / 占用），清除后刷新
  const [thumbStat, setThumbStat] = useState<{ count: number; bytes: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  // 2026-10 诊断日志（崩溃取证）：目录 / 文件数 / 总大小，导出中状态
  const [logStat, setLogStat] = useState<{ dir: string; count: number; bytes: number } | null>(null)
  const [logExporting, setLogExporting] = useState(false)
  // 2026-10 材质大类合并（docs/14 §2.3）：待合并数 / 来源目录 / 上次结果
  const materialMergeCount = useVault((s) => s.materialMergeCount)
  const materialMergeSources = useVault((s) => s.materialMergeSources)
  const materialMergeBusy = useVault((s) => s.materialMergeBusy)
  const mergeMaterial = useVault((s) => s.mergeMaterial)
  const detectMaterialMerge = useVault((s) => s.detectMaterialMerge)
  const [mergeResult, setMergeResult] = useState<{ moved: number; renamed: number; failed: number } | null>(null)
  /**
   * 「材质大类合并」是否**已经探测过**（`detectMaterialMerge` 已返回）。
   *
   * 为什么需要这个标志：`materialMergeCount` 初值就是 0，而探测是异步的 ——
   * 只看 `count === 0` 会在探测返回前先把「已完成」绿徽标画出来，若真有 500 个待合并，
   * 用户看到的就是一句假话。探测过之后再谈"已完成"，否则照旧给按钮（按钮自己的
   * `disabled` 也不依赖这个标志）。
   */
  const [mergeProbed, setMergeProbed] = useState(false)
  // 2026-10 库安全：重扫前索引备份（可恢复）
  const rescanBackupCount = useVault((s) => s.rescanBackupCount)
  const restoreLastRescanBackup = useVault((s) => s.restoreLastRescanBackup)
  const refreshRescanBackupCount = useVault((s) => s.refreshRescanBackupCount)
  const [restoreBusy, setRestoreBusy] = useState(false)
  // 强制重扫（允许清空索引）：两步确认 + 明示会丢什么 + 明示已自动备份
  const forceRescanAction = useVault((s) => s.forceRescan)
  const [forceOpen, setForceOpen] = useState(false)
  const [forceBusy, setForceBusy] = useState(false)
  const [forceAck, setForceAck] = useState(false)
  const [forcePreview, setForcePreview] = useState<{ gone: number; total: number; found: number } | null>(null)
  const [forceError, setForceError] = useState<string | null>(null)
  const [forceRemoved, setForceRemoved] = useState<number | null>(null)
  // v0.4 库一致性对账（按需检查，不在启动时跑）。
  // 三个复选框默认全 false = 点「检查」只看不改；只有用户勾选 + 点执行才会写库。
  const checkLibraryConsistency = useVault((s) => s.checkLibraryConsistency)
  const applyReconcile = useVault((s) => s.applyReconcile)
  const [consistencyBusy, setConsistencyBusy] = useState(false)
  const [report, setReport] = useState<ReconcileReport | null>(null)
  const [applyBusy, setApplyBusy] = useState(false)
  const [pickMissing, setPickMissing] = useState(false)
  const [pickNotIndexed, setPickNotIndexed] = useState(false)
  const [pickMismatch, setPickMismatch] = useState(false)
  // v1.0.13 重跑自动分类（词表/匹配规则升级后，旧资产不会自动变好）：
  // 候选数直接由索引算（与 store 的筛选口径同一个哨兵），为 0 时按钮禁用。
  const unclassifiedCount = useVault((s) => {
    const assets = s.assets
    let n = 0
    for (const a of assets) {
      const c1 = a.category1 ?? UNCLASSIFIED
      const c2 = a.category2 ?? UNCLASSIFIED
      if (c1 === UNCLASSIFIED && c2 === UNCLASSIFIED) n += 1
    }
    return n
  })
  const reclassifyBusy = useVault((s) => s.reclassifyBusy)
  const reclassifyBackupCount = useVault((s) => s.reclassifyBackupCount)
  const reclassifyUnclassified = useVault((s) => s.reclassifyUnclassified)
  const undoLastReclassify = useVault((s) => s.undoLastReclassify)
  const refreshReclassBackupCount = useVault((s) => s.refreshReclassBackupCount)
  const [reclassOpen, setReclassOpen] = useState(false)
  const [reclassResult, setReclassResult] = useState<{
    moved: number
    missed: number
    failed: number
  } | null>(null)
  const [undoResult, setUndoResult] = useState<{ restored: number; failed: number } | null>(null)
  /**
   * 知末「站方分类重排」（手动通道）—— 与上面「重跑自动分类」是**两条不同的通道**：
   * 上一段按**本地词表**重判，本段按**知末详情页的站方分类**重判；备份前缀、
   * 撤销入口、进度状态全部独立（`zhimoReclass` / `zhimoReclassBackupCount`）。
   *
   * 候选数在**渲染层**算（`isZhimoReclassCandidate` 是纯函数，与 store 同一口径），
   * 只用于按钮文案 + 置灰；真正跑的时候 store 会自己再筛一遍（索引可能刚变过）。
   */
  const zhimoReclass = useVault((s) => s.zhimoReclass)
  const zhimoReclassBackupCount = useVault((s) => s.zhimoReclassBackupCount)
  const runZhimoCategoryReclass = useVault((s) => s.runZhimoCategoryReclass)
  const cancelZhimoCategoryReclass = useVault((s) => s.cancelZhimoCategoryReclass)
  const refreshZhimoReclassBackupCount = useVault((s) => s.refreshZhimoReclassBackupCount)
  /** 候选数（`allAssets` 复用上面 library drift 那一个选择器，不重复订阅） */
  const zhimoCandidateCount = useMemo(
    () => allAssets.filter(isZhimoReclassCandidate).length,
    [allAssets]
  )
  const [zhimoReclassOpen, setZhimoReclassOpen] = useState(false)
  const [zhimoReclassResult, setZhimoReclassResult] = useState<ZhimoReclassSummary | null>(null)
  /**
   * 本轮是否被用户主动取消。
   *
   * 为什么在组件里记而不是读 store：`runZhimoCategoryReclass` 的返回值没有
   * `cancelled` 字段（老接口不动），而 `zhimoReclass.cancelRequested` 在结束时会被复位。
   * 取消只能从本页面（或窗口关闭）发起，所以组件内记一个布尔就足够，且不会误报。
   */
  const [zhimoCancelled, setZhimoCancelled] = useState(false)
  const [zhimoUndoResult, setZhimoUndoResult] = useState<{
    restored: number
    failed: number
  } | null>(null)
  // AI 辅助分类（docs/15 §7）：表单先本地编辑，失焦/切换时落库（避免每敲一个字符写一次 settings.json）
  const aiSettings: AiClassifySettings = settings?.aiClassify ?? {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: ''
  }
  const [aiForm, setAiForm] = useState<AiClassifySettings>(aiSettings)
  /**
   * AI 卡是否展开（默认收起，见 tab 里那段注释）。
   *
   * 只影响呈现，不参与落库：折叠时四个字段的值原样留在 `aiForm` 里，
   * 展开后立刻可见（不会因为折叠被清空）。
   */
  const [aiOpen, setAiOpen] = useState(false)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTest, setAiTest] = useState<{ ok: boolean; message: string } | null>(null)

  // 外部设置变化（另一个窗口/入口改了配置）→ 表单跟随（按字段比较，避免对象身份抖动）
  useEffect(() => {
    setAiForm(aiSettings)
  }, [aiSettings.enabled, aiSettings.baseUrl, aiSettings.apiKey, aiSettings.model])

  useEffect(() => {
    void window.modvault.sevenZipPath().then(setSevenZip)
    void window.modvault.thumbStats().then(setThumbStat).catch(() => undefined)
    void window.modvault.getAppVersion().then(setVersion).catch(() => undefined)
    // 诊断日志：打开设置时读一次目录 / 文件数 / 总大小（不 watch 文件系统）
    void window.modvault.logStats().then(setLogStat).catch(() => undefined)
    // 打开设置即刷新一次「待合并数量」（只读探测，不搬任何文件）
    void detectMaterialMerge().finally(() => setMergeProbed(true))
    // 只读刷新「可恢复的重扫备份」条数（决定按钮可用性）
    void refreshRescanBackupCount()
    // 只读刷新「可撤销的知末重排备份」条数（决定「撤销上次知末重排」按钮可用性）
    void refreshZhimoReclassBackupCount()
  }, [detectMaterialMerge, refreshRescanBackupCount, refreshZhimoReclassBackupCount])

  const refreshThumbStat = () => {
    void window.modvault.thumbStats().then(setThumbStat).catch(() => undefined)
  }

  const refreshLogStat = () => {
    void window.modvault.logStats().then(setLogStat).catch(() => undefined)
  }

  /**
   * Esc 关闭（0.7.6 T-ESC 真机返工）。
   *
   * 本弹窗外壳是**自绘** `dialog-scrim`（见下面 return，不走 `Modal`），所以必须自己占一层。
   * 少了这一步的后果（qa-real076 真机复现）：`hasEscLayer()` 为 false → Esc 落到 App 的
   * 全局 `decideEsc` → `settingsOpen` 命中 `'close-settings'`；而别名输入框的
   * `data-esc-own` 只被 `Modal` 认，自绘外壳这条支路根本没经过它 → 「草稿回滚了、
   * 弹窗也被关掉」。
   *
   * 现在两层保障同时成立：本层在栈里（App 不动作）+ `useEscLayer` 认 `data-esc-own`
   * （输入框那一格按 Esc 只回滚草稿，不关弹窗）。
   *
   * 0.7.8 T-ZSTACK：返回值是**本层在层栈里的位置**，遮罩的 z-index 由它算出（见
   * `logic/zStack.ts`）。层级与 Esc 应答因此同源：设置开着时再开一个弹窗，新弹窗是栈顶
   * （z 更高、Esc 先答它）；它一关，本层重新变成栈顶，z 也回到 50。
   */
  const escDepth = useEscLayer(onClose, !!settings)

  if (!settings) return null

  const flash = () => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1200)
  }

  /**
   * 「按站方分类重排」运行中的进度块。
   *
   * 抽成变量是因为设置页段落与确认弹窗**共用同一份**（弹窗打开时遮住了下面的段落，
   * 两处各写一遍必然漂移）。取消语义必须写在旁边：**取消 ≠ 回滚**，
   * 底层只停止"发新请求"，已经抓到的命中照样落库 —— 写成"什么都没做"就是骗人。
   */
  const zhimoProgressBlock = zhimoReclass.running ? (
    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
      <span className="text-[11px] text-secondary">
        已完成 <span className="font-semibold text-primary">{zhimoReclass.done}</span> / 共{' '}
        {zhimoReclass.total}
      </span>
      <button
        className="btn !py-1 text-xs"
        disabled={zhimoReclass.cancelRequested}
        onClick={() => {
          // 本地记一笔"本轮被取消"（store 的 cancelRequested 结束时会复位，读不到历史）
          setZhimoCancelled(true)
          cancelZhimoCategoryReclass()
        }}
      >
        {zhimoReclass.cancelRequested ? '正在停止…' : '取消'}
      </button>
      <span className="text-[10px] text-muted">
        取消只是不再抓新记录；
        <span className="text-secondary">已抓到的结果会照常落库</span>。
      </span>
    </div>
  ) : null

  /**
   * 「按站方分类重排」结束后的汇总块（运行中不显示）。
   *
   * 六个桶全部列出，`approx` **单列并解释** —— 它是 `moved` 的子集，
   * 代表"站方类目在本地没有一一对应，按已核准的相近类目归并"的条数，
   * 是用户判断"有多少条是就近猜的"的唯一依据。
   */
  const zhimoResultBlock =
    zhimoReclassResult && !zhimoReclass.running ? (
      <div className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[11px] leading-relaxed text-secondary">
        <div>
          {zhimoCancelled ? (
            <>
              已取消：本轮抓取 {zhimoReclassResult.scanned} / 共 {zhimoReclass.total} 条候选
              {zhimoReclassResult.scanned < zhimoReclass.total ? '（剩余未跑）' : ''}，
              <span className="text-secondary">已抓到的结果已照常落库</span>。
            </>
          ) : (
            <>上次重排完成。</>
          )}
        </div>
        <div className="mt-1">
          移动{' '}
          <span className="font-semibold text-primary">{zhimoReclassResult.moved}</span>{' '}
          个（其中近似归并{' '}
          <span className="font-semibold">{zhimoReclassResult.approx}</span> 个）；多候选{' '}
          {zhimoReclassResult.ambiguous} · 未映射 {zhimoReclassResult.unmapped} · 站方未给{' '}
          {zhimoReclassResult.noStation} · 失败{' '}
          <span
            className={
              zhimoReclassResult.failed > 0 ? 'font-semibold text-danger' : 'font-semibold'
            }
          >
            {zhimoReclassResult.failed}
          </span>
          。
        </div>
        <div className="mt-1 text-[10px] text-muted">
          「近似归并」= 站方类目在本地没有一一对应，按已核准的「相近类目」归并（日志里标 approx）。
        </div>
      </div>
    ) : null

  const clearThumbs = async () => {
    setClearing(true)
    try {
      await window.modvault.clearThumbs()
    } finally {
      setClearing(false)
      refreshThumbStat()
    }
  }

  /**
   * 打开「强制重扫」确认框，并先做一次**只读预演**（不删任何东西）：
   * 用当前索引与扫描结果对比，算出"会被删掉多少"，让确认框里说的是真实数字 N 而不是恐吓话术。
   * 确认后 `forceRescan()` 会再扫一次（宁可多扫一遍，也不把预演结果当作删除依据）。
   */
  const openForceRescan = async () => {
    setForceOpen(true)
    setForceAck(false)
    setForceRemoved(null)
    setForcePreview(null)
    setForceError(null)
    setForceBusy(true)
    try {
      const r = await window.modvault.rescan()
      const local = useVault.getState().assets
      const foundFolders = new Set(r.assets.map((a) => a.folder))
      const found = local.filter((a) => foundFolders.has(a.folder)).length
      setForcePreview({ gone: local.length - found, total: local.length, found })
    } catch {
      setForceError('无法完成扫描预览（磁盘或库目录不可读），请检查库目录后重试。')
    } finally {
      setForceBusy(false)
    }
  }

  /** 索引快照导出（P0-6）：Dexie 里的资产 JSON → 主进程保存对话框落盘 */
  const exportIndex = async () => {    const json = JSON.stringify(useVault.getState().assets)
    const p = await window.modvault.exportIndexBackup(json).catch(() => null)
    if (p) {
      useVault.setState({ notice: `索引快照已导出：${p}` })
    } else {
      useVault.setState({ notice: '导出已取消或失败' })
    }
  }

  /**
   * 导出诊断日志：主进程弹保存对话框 → 把 logs 目录打成 zip。
   * 用户取消**不提示失败**（canceled=true），只有真正失败才提示。
   */
  const exportLogs = async () => {
    setLogExporting(true)
    try {
      const r = await window.modvault.exportLogs().catch(() => null)
      if (!r) {
        useVault.setState({ notice: '日志导出失败（主进程无响应）' })
        return
      }
      if (r.canceled) return
      if (r.path) {
        useVault.setState({ notice: `诊断日志已导出（${r.files} 个文件）：${r.path}` })
      } else {
        useVault.setState({ notice: '日志导出失败，请稍后重试' })
      }
    } finally {
      setLogExporting(false)
      refreshLogStat()
    }
  }

  /**
   * v0.4 库一致性检查：**只读**。
   *
   * 这里只做三件事：① 调 `checkLibraryConsistency()`（内部唯一 IO 是一次
   * `window.modvault.rescan()` 纯扫描）② 把报告放进 state ③ 关掉 loading。
   * **没有 db.assets 写入、没有 set({ assets })、没有任何磁盘操作**——
   * 真正的修改全部在每个复选框 + 「执行所选修复」之后（见 runRepair）。
   */
  const runConsistencyCheck = async () => {
    setConsistencyBusy(true)
    try {
      const r = await checkLibraryConsistency()
      setReport(r)
      // 每次打开报告都从「一项都不勾」开始：默认不改任何东西
      setPickMissing(false)
      setPickNotIndexed(false)
      setPickMismatch(false)
    } catch (err) {
      useVault.setState({
        notice: `检查失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      setConsistencyBusy(false)
    }
  }

  /** 绝对路径 → 相对库根目录（展示用；Windows 前缀比较忽略大小写） */
  const relDirOf = (folder: string): string => {
    const root = (settings?.libraryDir ?? '').replace(/[\\/]+$/, '')
    if (!root) return folder
    if (folder.toLowerCase().startsWith(root.toLowerCase())) {
      return folder.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    }
    return folder
  }

  /** 单条差异的人话说明 */
  const reasonOf = (item: DiffItem): string => {
    if (item.kind === 'missing-on-disk') return '索引里有，磁盘上已找不到（可能被删或移走）'
    if (item.kind === 'not-in-index') return '磁盘上有，索引里还没有（手动放进来的）'
    const idx = item.indexCategory?.join(' / ') ?? ''
    const disk = item.diskCategory?.join(' / ') ?? ''
    return `分类不一致：索引「${idx}」→ 磁盘「${disk}」`
  }

  /** 执行用户勾选的修复（唯一会写库的入口） */
  const runRepair = async () => {
    if (!report) return
    const actions = {
      removeIndex: pickMissing
        ? report.items
            .filter((i) => i.kind === 'missing-on-disk')
            .map((i) => i.id)
            .filter((x): x is string => typeof x === 'string')
        : [],
      addIndex: pickNotIndexed
        ? report.items.filter((i) => i.kind === 'not-in-index' && i.scanned).map((i) => i.scanned!)
        : [],
      fixCategory: pickMismatch
        ? report.items
            .filter((i) => i.kind === 'category-mismatch')
            .map((i) => i.id)
            .filter((x): x is string => typeof x === 'string')
        : []
    }
    setApplyBusy(true)
    try {
      await applyReconcile(actions)
      setReport(null)
      // 移除记录会写一份重扫备份 → 刷新「可恢复备份」条数
      void refreshRescanBackupCount()
    } finally {
      setApplyBusy(false)
    }
  }

  /** 当前勾选的类别数（0 → 执行按钮禁用） */
  const pickedCount = (pickMissing ? 1 : 0) + (pickNotIndexed ? 1 : 0) + (pickMismatch ? 1 : 0)

  /** AI 表单落库：`patch` 与本地值合并后整体保存（main 侧还会做一次逐字段归一化） */
  const commitAi = (patch: Partial<AiClassifySettings>) => {
    const next: AiClassifySettings = { ...aiForm, ...patch }
    setAiForm(next)
    void saveSettings({ aiClassify: next })
  }

  /**
   * 「测试连接」：只发一条最小请求（不分类、不注入词表），
   * 失败原因（401 / 404 / 模型名错 / 超时）原样展示，方便用户自查。
   */
  const testAi = async () => {
    setAiTesting(true)
    setAiTest(null)
    try {
      const r = await window.modvault.aiClassifyTest(aiForm)
      setAiTest(r)
    } catch (err) {
      setAiTest({
        ok: false,
        message: `测试失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      setAiTesting(false)
    }
  }

  // ── 各 tab 内容（v0.8.1 重排：卡片 + 行的统一语言） ─────────────

  const appearanceTab = (
    <div className="flex flex-col gap-[13px]">
      <SettingsCard title="主题">
        {/* 主题三卡按设计稿放**右侧并排**（v0.8.1 尺寸放大到 900 后重新核算）：
            内容区宽 = 900 − 172(左栏) − 64(px-8 左右) = 664，卡内可用 628；
            三张 112 + 两个 10 gap = 356，左侧还剩 272 给「界面主题 + 摘要」。
            实测（headless Chrome 量 900×680）：摘要折成两行也不增加行高 ——
            这一行的高度由 86px 的缩略卡决定，所以纵向块（207）改回并排只要 153，
            省 54px 且与设计稿一致。 */}
        <SettingsRow
          title="界面主题"
          desc="跟随系统时切系统深色会即时生效，不需重启。"
          actions={
            <div className="flex gap-[10px]">
              {(['light', 'dark', 'system'] as const).map((mode) => {
                const active = settings.theme === mode
                return (
                  <button
                    key={mode}
                    className={`w-[112px] rounded-[10px] border p-[7px] text-left transition ${
                      active
                        ? 'border-accent bg-card shadow-[0_0_0_2px_var(--accent-tint)]'
                        : 'border-panel-line bg-card hover:border-line'
                    }`}
                    onClick={() => {
                      void saveSettings({ theme: mode })
                      flash()
                    }}
                    title={
                      mode === 'light'
                        ? '浅色 Soft UI'
                        : mode === 'dark'
                          ? '深色 Vibrancy'
                          : '跟随 Windows 深浅色设置（系统切换时实时跟随）'
                    }
                  >
                    <div className="mb-[7px] overflow-hidden rounded-[6px] border border-soft-line">
                      <ThemePreview mode={mode} />
                    </div>
                    <span
                      className={`block text-center text-[11.5px] ${
                        active ? 'font-medium text-accent-text' : 'text-secondary'
                      }`}
                    >
                      {mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}
                    </span>
                  </button>
                )
              })}
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="动效"
        note="三档只改渲染上限与过渡幅度，不改任何数据；渲染参数在下一次打开材质球时生效。"
      >
        <SettingsRow
          title="动效性能"
          desc="流畅：少位移不模糊 · 均衡（默认）· 极致：带失焦与更大景深"
          actions={
            <div className={SEG_GROUP_CLASS} role="radiogroup" aria-label="动效性能">
              {MOTION_ORDER.map((q) => {
                const profile = MOTION_PROFILES[q]
                const active = settings.motionQuality === q
                return (
                  <button
                    key={q}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={profile.hint}
                    className={segItemClass(active)}
                    onClick={() => {
                      void saveSettings({ motionQuality: q })
                      flash()
                    }}
                  >
                    <span>{profile.label}</span>
                    {q === 'balanced' && (
                      <span className="text-[10.5px] font-normal text-muted">默认</span>
                    )}
                  </button>
                )
              })}
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard title="侧栏显示" note="关掉后侧栏不显示该入口，对应的筛选状态会一并清空。">
        <SettingsRow
          title="操作提示"
          desc="中栏顶部显示「双击定位 / 拖拽拖出」的提示文本"
          actions={
            <Toggle
              checked={settings.showHelpHint}
              onChange={(v) => void saveSettings({ showHelpHint: v })}
            />
          }
        />
        <SettingsRow
          title="收藏"
          desc="侧栏显示「收藏」入口（只看已收藏）"
          actions={
            <Toggle
              checked={settings.showFavorites !== false}
              onChange={(v) => {
                void saveSettings({ showFavorites: v })
                flash()
              }}
            />
          }
        />
        <SettingsRow
          title="色标"
          desc="侧栏显示色标筛选的六个色点"
          actions={
            <Toggle
              checked={settings.showColorTags !== false}
              onChange={(v) => {
                void saveSettings({ showColorTags: v })
                flash()
              }}
            />
          }
        />
        <SettingsRow
          title="重复资产"
          desc="侧栏显示「重复资产」入口（按名字分组的重复清单）"
          actions={
            <Toggle
              checked={settings.showDuplicates !== false}
              onChange={(v) => {
                void saveSettings({ showDuplicates: v })
                flash()
              }}
            />
          }
        />
      </SettingsCard>
    </div>
  )

  const importTab = (
    <div className="flex flex-col gap-[13px]">
      <SettingsCard
        title="压缩包处置"
        note={
          <>
            「彻底删除」不经回收站，<b className="font-medium text-secondary">无法恢复</b>
            ；单张图片也走同一设置。
          </>
        }
      >
        <SettingsRow
          title="导入后怎么处理原压缩包"
          desc="导入成功才处置；失败或跳过一律保留原包。"
          actions={
            <div className={SEG_GROUP_CLASS} role="radiogroup" aria-label="原压缩包处置">
              {DISPOSAL_ORDER.map((d) => {
                const active = settings.archiveDisposal === d
                return (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={DISPOSAL_HINT[d]}
                    className={segItemClass(active)}
                    onClick={() => {
                      void saveSettings({ archiveDisposal: d })
                      flash()
                    }}
                  >
                    <span>{DISPOSAL_LABEL[d]}</span>
                    {d === 'recycle' && (
                      <span className="text-[10.5px] font-normal text-muted">默认</span>
                    )}
                  </button>
                )
              })}
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="解压"
        note="未安装 7-Zip 时 .rar / .7z 只能用内置 zip 引擎，遇到不支持的格式会提示你安装 7-Zip。"
      >
        <SettingsRow
          title="同时解压任务数"
          desc="默认 2；机械硬盘或低配可降到 1，SSD 可提到 4"
          actions={
            <div className="flex items-center gap-2 rounded-[8px] border border-line px-1 py-0.5">
              <button
                className="flex h-6 w-6 items-center justify-center rounded-md text-secondary transition hover:bg-elevated disabled:opacity-30"
                disabled={settings.extractConcurrency <= 1}
                onClick={() => {
                  void saveSettings({
                    extractConcurrency: Math.max(1, settings.extractConcurrency - 1)
                  })
                  flash()
                }}
                title="减少"
              >
                −
              </button>
              <span className="w-6 text-center text-[13px] font-medium">
                {settings.extractConcurrency}
              </span>
              <button
                className="flex h-6 w-6 items-center justify-center rounded-md text-secondary transition hover:bg-elevated disabled:opacity-30"
                disabled={settings.extractConcurrency >= 8}
                onClick={() => {
                  void saveSettings({
                    extractConcurrency: Math.min(8, settings.extractConcurrency + 1)
                  })
                  flash()
                }}
                title="增加"
              >
                +
              </button>
            </div>
          }
        />
        {/* 原「高级」tab 的唯一内容搬到这里：解压能力属于「东西进来时」的事。
            检测状态完全复用既有 `sevenZipPath()`（不新写 shell 调用）。 */}
        <SettingsRow
          title="7-Zip"
          desc={
            <span className="flex flex-wrap items-center gap-1.5">
              <code className="font-mono text-[11.5px] text-secondary" title={sevenZip ?? undefined}>
                {sevenZip ?? '未检测到 7z.exe'}
              </code>
              <span className="text-muted">·</span>
              {sevenZip ? (
                <StatusBadge tone="ok">已找到</StatusBadge>
              ) : (
                <StatusBadge tone="warn">未找到</StatusBadge>
              )}
              <span>rar / 7z 依赖它</span>
            </span>
          }
          actions={
            <>
              {!sevenZip && (
                <a
                  className="text-[11px] text-accent-text underline underline-offset-2"
                  href={SEVEN_ZIP_DOWNLOAD_URL}
                  target="_blank"
                  rel="noreferrer"
                  title="打开 7-Zip 官方下载页"
                >
                  下载 ↗
                </a>
              )}
              <button
                className="btn !py-1 text-xs"
                onClick={async () => {
                  const dir = await window.modvault.pickWatchDir()
                  if (dir) {
                    const guess = `${dir}\\7z.exe`
                    await saveSettings({ sevenZipPath: guess })
                    setSevenZip(guess)
                    flash()
                  }
                }}
                title="手动指定 7z.exe 所在目录（选到 7z.exe 同级即可）"
              >
                指定 7z.exe
              </button>
              <button
                className="btn !py-1 text-xs"
                onClick={() => {
                  void window.modvault
                    .sevenZipPath()
                    .then(setSevenZip)
                    .catch(() => setSevenZip(null))
                }}
                title="重新探测 7z.exe（装完 7-Zip 后点这里，不用重启）"
              >
                重新检测
              </button>
            </>
          }
        />
      </SettingsCard>

      <SettingsCard title="命名">
        <SettingsRow
          title="命名模板"
          desc="「重命名…」弹窗的默认模板，只改文件夹名。占位符 {name} {c1} {c2} {year} {n}"
          actions={
            <input
              className="input w-52 font-mono text-[12px]"
              value={tplDraft ?? settings.renameTemplate}
              placeholder="{c1}-{c2}-{name}"
              spellCheck={false}
              onChange={(e) => setTplDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              onBlur={() => {
                const next = (tplDraft ?? '').trim()
                setTplDraft(null)
                // 空模板不落盘（保留旧的默认值），避免用户清空后弹窗模板变成空串
                if (next && next !== settings.renameTemplate) {
                  void saveSettings({ renameTemplate: next })
                  flash()
                }
              }}
            />
          }
        />
      </SettingsCard>

      <SettingsCard
        title="来源与封面"
        note="监控目录会在文件写入稳定后自动导入（浏览器边下边写会等 2 秒）；建议只监控一个专用下载文件夹。"
      >
        <SettingsRow
          title="监控下载目录"
          desc="拖入是主路径；开启后还会盯这个目录，新包自动导入"
          actions={
            <>
              {settings.watchDir && (
                <code
                  className="max-w-[160px] truncate rounded-md bg-canvas px-2 py-1 text-[11px] text-secondary"
                  title={settings.watchDir}
                >
                  {settings.watchDir}
                </code>
              )}
              <button
                className="btn !py-1 text-xs"
                onClick={async () => {
                  const dir = await window.modvault.pickWatchDir()
                  if (dir) {
                    await saveSettings({ watchDir: dir, watchEnabled: true })
                    flash()
                  }
                }}
              >
                选择目录
              </button>
              <Toggle
                checked={settings.watchEnabled}
                onChange={(v) => {
                  void saveSettings({ watchEnabled: v })
                  flash()
                }}
              />
            </>
          }
        />
        <SettingsRow
          title="自动从知末获取模型封面"
          desc="只对模型、且名字里带知末 ID 的资产生效；材质 / 贴图不做"
          actions={
            <Toggle
              checked={settings.zhimoCover}
              onChange={(v) => {
                void saveSettings({ zhimoCover: v })
                flash()
              }}
            />
          }
        />
        {/* 子开关：总开关关闭时置灰但**不改值**（下次打开总开关用户偏好还在）。 */}
        <SettingsRow
          title="包内已有预览图时也替换"
          desc="关闭后，压缩包里自带的图片会优先保留 —— 注意有些包自带的其实是材质贴图，不是模型预览。"
          actions={
            <Toggle
              checked={settings.zhimoCoverReplacePacked}
              disabled={settings.zhimoCover === false}
              onChange={(v) => {
                void saveSettings({ zhimoCoverReplacePacked: v })
                flash()
              }}
            />
          }
        />
        <SettingsRow
          title="默认来源标签"
          desc="导入时打上的来源，之后可在详情里改"
          actions={
            <input
              className="input !w-32 !py-1 text-xs"
              value={settings.defaultSource}
              onChange={(e) => void saveSettings({ defaultSource: e.target.value })}
            />
          }
        />
      </SettingsCard>
    </div>
  )

  /**
   * 分类 tab（v0.8.1 新增）。
   *
   * 原来这些项散在「导入」里，和"东西怎么进来"混在一起 —— 但它们回答的是
   * "进来**之后**怎么归类"，而且都带"会移动磁盘目录"的副作用，必须自成一组。
   */
  const classifyTab = (
    <div className="flex flex-col gap-[13px]">
      <SettingsCard
        title="导入时"
        note={
          <>
            站方类目在本地没有对应时，按已核准的「相近类目」归并，日志里标{' '}
            <code className="font-mono text-[11px]">approx</code>，可回溯。
          </>
        }
      >
        <SettingsRow
          title="按站方分类自动落库"
          desc="批次结束后只处理未分类的资产，已分类的一律不动。"
          actions={
            <Toggle
              checked={settings.zhimoAutoCategory}
              onChange={(v) => {
                void saveSettings({ zhimoAutoCategory: v })
                flash()
              }}
            />
          }
        />
      </SettingsCard>

      {/* @guard:zhimo-reclass —— 本卡（含卡底 note 与两条重排 + 一致性检查）是
          「分类」的存量维护控件集；源码守卫（zhimoSettings.test.ts）按这对标记切段做红线检查。
          标记上移到卡片开头：份数说明现在写在 note 里（右栏只留操作按钮），
          而 note 是 `<SettingsCard>` 的属性、在源码里位于 children 之前。 */}
      {/* @guard:zhimo-reclass */}
      <SettingsCard
        title="存量重排"
        note={
          <>
            两个重排都只处理「未分类」的资产；移动前自动备份，各自只保留最近 3 份 —— 当前
            {reclassifyBackupCount + zhimoReclassBackupCount > 0 ? (
              <>
                可撤销备份{' '}
                <b className="font-medium text-secondary">{reclassifyBackupCount}</b> 份（重跑自动分类）
                · <b className="font-medium text-secondary">{zhimoReclassBackupCount}</b> 份（按站方分类重排）。
              </>
            ) : (
              <>暂无可撤销备份。</>
            )}
            「按站方分类自动落库」开关只约束导入后的自动任务，手动按钮不受此开关影响。
            检查只读，用于发现三类偏差：磁盘已删的索引记录、拖进库但没索引的资产、目录改名导致的分类不一致。
          </>
        }
      >
        <SettingsRow
          title="重跑自动分类"
          desc={
            <>
              按当前词表重新判定 · 当前{' '}
              <b className="font-semibold text-primary">{unclassifiedCount}</b> 个未分类资产
            </>
          }
          actions={
            <>
              <button
                className="btn !py-1 text-xs"
                disabled={reclassifyBusy || unclassifiedCount === 0 || materialMergeBusy}
                onClick={() => {
                  setReclassResult(null)
                  setUndoResult(null)
                  setReclassOpen(true)
                }}
                title={
                  materialMergeBusy
                    ? '材质大类合并进行中，暂不能重跑分类'
                    : unclassifiedCount === 0
                      ? '当前没有「未分类/未分类」的资产'
                      : '按当前词表重新判定一次；移动前会自动备份，可撤销'
                }
              >
                <IconRefresh />
                {reclassifyBusy ? '处理中…' : '重跑自动分类'}
              </button>
              <button
                className="btn !py-1 text-xs"
                disabled={reclassifyBusy || reclassifyBackupCount === 0}
                onClick={async () => {
                  setReclassResult(null)
                  const r = await undoLastReclassify()
                  setUndoResult(r)
                  void refreshReclassBackupCount()
                }}
                title={
                  reclassifyBackupCount === 0
                    ? '还没有重跑备份：每次重跑移动前会自动备份一份'
                    : '把上次重跑移动过的资产按原分类搬回去'
                }
              >
                <IconRefresh />
                撤销上次重跑
              </button>
            </>
          }
        />
        {reclassResult && (
          <p className="pb-2 text-[11px] leading-[1.5] text-secondary">
            上次重跑：移动{' '}
            <span className="font-semibold text-primary">{reclassResult.moved}</span> 个，未识别{' '}
            {reclassResult.missed} 个
            {reclassResult.failed > 0 && (
              <>
                ，失败 <span className="font-semibold text-danger">{reclassResult.failed}</span> 个
              </>
            )}
            。
          </p>
        )}
        {undoResult && (
          <p className="pb-2 text-[11px] leading-[1.5] text-secondary">
            上次撤销：还原 <span className="font-semibold text-primary">{undoResult.restored}</span>{' '}
            个
            {undoResult.failed > 0 && (
              <>
                ，失败 <span className="font-semibold text-danger">{undoResult.failed}</span> 个
              </>
            )}
            。
          </p>
        )}

        {/* 旧的内层标记已上移到卡片开头（份数说明搬进 note 后，守卫需要连 note 一起切） */}
        <SettingsRow
          title="按站方分类重跑"
          desc={
            <>
              按知末详情页搬目录 · <b className="font-semibold text-primary">会真实移动磁盘上的目录</b>
            </>
          }
          actions={
            <>
              <button
                className="btn !py-1 text-xs"
                disabled={
                  zhimoReclass.running ||
                  reclassifyBusy ||
                  zhimoCandidateCount === 0 ||
                  materialMergeBusy
                }
                onClick={() => {
                  setZhimoReclassResult(null)
                  setZhimoUndoResult(null)
                  setZhimoCancelled(false)
                  setZhimoReclassOpen(true)
                }}
                title={
                  materialMergeBusy
                    ? '材质大类合并进行中，暂不能重排分类'
                    : reclassifyBusy
                      ? '另一条分类通道正在跑，请稍候'
                      : zhimoCandidateCount === 0
                        ? '当前没有「未分类」且带知末 ID 的资产'
                        : '按知末站方分类重排；会真实移动目录，移动前自动备份，可撤销（备份前缀 zhimo-reclass-）'
                }
              >
                <IconRefresh />
                {zhimoReclass.running
                  ? '处理中…'
                  : `按站方分类重跑（${zhimoCandidateCount} 个）`}
              </button>
              <button
                className="btn !py-1 text-xs"
                disabled={zhimoReclass.running || reclassifyBusy || zhimoReclassBackupCount === 0}
                onClick={async () => {
                  setZhimoReclassResult(null)
                  const r = await undoLastReclassify(ZHIMO_RECLASS_BACKUP_PREFIX)
                  setZhimoUndoResult(r)
                  void refreshZhimoReclassBackupCount()
                }}
                title={
                  zhimoReclassBackupCount === 0
                    ? '还没有知末重排备份：每次重排移动前会自动备份一份'
                    : '把上次「按站方分类重排」移动过的资产按原分类搬回去（备份前缀 zhimo-reclass-，与「重跑自动分类」的 reclass- 互不干扰）'
                }
              >
                <IconRefresh />
                撤销上次知末重排
              </button>
            </>
          }
        />
        {zhimoProgressBlock}
        {zhimoResultBlock}
        {zhimoUndoResult && (
          <p className="pb-2 text-[11px] leading-[1.5] text-secondary">
            上次撤销：还原{' '}
            <span className="font-semibold text-primary">{zhimoUndoResult.restored}</span> 个
            {zhimoUndoResult.failed > 0 && (
              <>
                ，失败 <span className="font-semibold text-danger">{zhimoUndoResult.failed}</span> 个
              </>
            )}
            。
          </p>
        )}
        {/* 一致性检查（原为独立「检查」卡）：同一张卡第 3 行 —— 三者都是
            "对存量库按某个依据重排/核对"的维护动作，拆两张卡等于同一心智单元拆两半。 */}
        <SettingsRow
          title="库一致性检查"
          desc={
            <>
              只读比对索引与磁盘，<span className="text-secondary">不改任何东西</span>
            </>
          }
          actions={
            <button
              className="btn !py-1 text-xs"
              disabled={consistencyBusy || materialMergeBusy}
              onClick={() => void runConsistencyCheck()}
              title="扫描库目录并与索引对比（只读，不会修改任何东西）"
            >
              <IconRefresh />
              {consistencyBusy ? '扫描中…' : '开始检查'}
            </button>
          }
        />
        {/* @guard:zhimo-reclass-end */}
      </SettingsCard>

      {/* AI 辅助分类（可选）：词表优先 + 模型兜底，不内置任何模型。
          默认关闭；未填写 = 零网络请求。表单失焦落库（不逐字符写 settings.json）。

          v0.8.1 尺寸收敛（用户裁定 A1）：**默认折叠**成一行 —— 90% 的用户永远不填这四项，
          展开的 172px 表单会把它上面的两张卡顶出视口。折叠态仍必须能看出开关状态：
          摘要第一句就是「已开启 · 模型 xxx」/「未开启」，状态不藏。
          展开按钮是原生 `<button>` + `aria-expanded` + `aria-controls`，Enter / Space 可用。 */}
      <SettingsCard
        title="AI 辅助分类（可选）"
        note={
          aiOpen
            ? '兼容 OpenAI 格式的 /chat/completions 接口（OpenAI、DeepSeek、通义、Ollama 等）。密钥仅保存在本机 settings.json；识别不了或请求失败时保持「未分类」，不会打断导入，也不会覆盖已分类的资产。'
            : undefined
        }
      >
        <SettingsRow
          title="模型兜底"
          desc={
            aiForm.enabled
              ? `已开启${aiForm.model.trim() ? ` · 模型 ${aiForm.model.trim()}` : ' · 尚未填写模型名'}；仅当词表无法判断时才调用`
              : '未开启；仅当词表无法判断时才调用，只发送资产名，不发送文件内容'
          }
          actions={
            <>
              <button
                type="button"
                className="btn !py-1 text-xs"
                aria-expanded={aiOpen}
                aria-controls="ai-classify-fields"
                onClick={() => setAiOpen((v) => !v)}
                title={aiOpen ? '收起接口设置' : '展开填写接口地址 / 密钥 / 模型名'}
              >
                {aiOpen ? '收起' : '展开填接口信息'}
              </button>
              <Toggle checked={aiForm.enabled} onChange={(v) => commitAi({ enabled: v })} />
            </>
          }
        />
        {aiOpen && (
          <div id="ai-classify-fields" className="border-t border-soft-line py-2.5">
            <div className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-2">
              <label className="text-[11px] text-secondary" htmlFor="ai-base-url">
                接口地址
              </label>
              <input
                id="ai-base-url"
                className="input !py-1 text-xs"
                value={aiForm.baseUrl}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                onChange={(e) => setAiForm({ ...aiForm, baseUrl: e.target.value })}
                onBlur={() => commitAi({})}
              />

              <label className="text-[11px] text-secondary" htmlFor="ai-api-key">
                密钥
              </label>
              <input
                id="ai-api-key"
                className="input !py-1 text-xs"
                type="password"
                value={aiForm.apiKey}
                placeholder="sk-…（本地服务可留空）"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })}
                onBlur={() => commitAi({})}
              />

              <label className="text-[11px] text-secondary" htmlFor="ai-model">
                模型名
              </label>
              <input
                id="ai-model"
                className="input !py-1 text-xs"
                value={aiForm.model}
                placeholder="gpt-4o-mini / qwen2.5:7b"
                spellCheck={false}
                onChange={(e) => setAiForm({ ...aiForm, model: e.target.value })}
                onBlur={() => commitAi({})}
              />
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                className="btn !py-1 text-xs"
                disabled={aiTesting || !aiForm.baseUrl.trim() || !aiForm.model.trim()}
                onClick={() => void testAi()}
                title="发一条最小请求，验证地址 / 密钥 / 模型名是否可用"
              >
                <IconRefresh />
                {aiTesting ? '测试中…' : '测试连接'}
              </button>
              {aiTest && (
                <span
                  className={`max-w-[320px] truncate text-[11px] ${
                    aiTest.ok ? 'text-success' : 'text-danger'
                  }`}
                  title={aiTest.message}
                >
                  {aiTest.message}
                </span>
              )}
            </div>
          </div>
        )}
      </SettingsCard>
    </div>
  )

  const libraryTab = (
    <div className="flex flex-col gap-[13px]">
      <SettingsCard title="位置" note="换库不会删旧索引；确认新目录无误后再点「重新扫描」重建。">
        <SettingsRow
          title="库目录"
          desc={
            <code className="font-mono text-[11.5px] text-secondary">{settings.libraryDir}</code>
          }
          notice={
            /*
             * DEF-19-3：索引路径与当前库目录不一致时的**可行动**提示。
             *
             * 为什么必须提示：`probeSizes` 的越界守卫会让老资产的尺寸回填全部返回空
             * （`scanned:N, patched:0`），分辨率筛选于是永远筛不到它们，而日志里只有一行
             * WARN —— 用户看不到日志，只会觉得"筛选坏了"。
             *
             * 只给只读入口，**绝不**放一个"点了就重建索引"的按钮：重建会丢标签/备注/风格，
             * 必须先看「库一致性检查」的结果再决定（那也是这里唯一的行动指向）。
             * outsideCount === 0 时 `driftWarning` 为 null → 整块不渲染（零视觉噪音）。
             */
            driftWarning ? (
              <div className="mt-1.5 rounded-lg border border-danger/40 bg-danger-tint px-2.5 py-2 text-[11px] leading-relaxed text-danger">
                <div className="font-medium">{driftWarning.title}</div>
                <div className="mt-1">{driftWarning.body}</div>
              </div>
            ) : null
          }
          actions={
            <>
              <button
                className="btn !py-1 text-xs"
                onClick={async () => {
                  await window.modvault.chooseLibrary()
                  flash()
                }}
              >
                更换…
              </button>
              <button
                className="btn !py-1 text-xs"
                onClick={() => window.modvault.openLibrary()}
              >
                打开
              </button>
            </>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="索引维护"
        note={
          <>
            外部改名或移动过的资产会被当作新资产重新索引，
            <b className="font-medium text-secondary">原有标签 / 备注 / 风格会丢失</b>
            ；删除的记录会先自动备份。
          </>
        }
      >
        <SettingsRow
          title="重新扫描"
          desc="对比磁盘与索引，找回被移动或改名过的资产"
          actions={
            <button
              className="btn !py-1 text-xs"
              disabled={rescanBusy || materialMergeBusy}
              onClick={async () => {
                setRescanBusy(true)
                try {
                  await rescan()
                } finally {
                  setRescanBusy(false)
                }
              }}
              title={materialMergeBusy ? '材质大类合并进行中，暂不能重扫' : undefined}
            >
              <IconRefresh />
              {rescanBusy ? '扫描中…' : '重新扫描'}
            </button>
          }
        />
        <SettingsRow
          title="恢复重扫前索引"
          desc={
            rescanBackupCount > 0
              ? `可用备份 ${rescanBackupCount} 份 · 只保留最近 5 份`
              : '暂无重扫备份'
          }
          actions={
            <button
              className="btn !py-1 text-xs"
              disabled={rescanBackupCount === 0 || restoreBusy}
              onClick={async () => {
                setRestoreBusy(true)
                try {
                  await restoreLastRescanBackup()
                } finally {
                  setRestoreBusy(false)
                  void refreshRescanBackupCount()
                }
              }}
              title={
                rescanBackupCount === 0
                  ? '还没有重扫备份：每次重扫真正删除记录前会自动备份一份'
                  : '把最近一次重扫删掉的资产记录（含标签/备注/风格）恢复到索引'
              }
            >
              <IconRefresh />
              {restoreBusy ? '恢复中…' : '恢复'}
            </button>
          }
        />
      </SettingsCard>

      <SettingsCard title="结构迁移">
        <SettingsRow
          title="迁移旧版目录结构"
          desc={
            legacyLayoutCount > 0
              ? `检测到 ${legacyLayoutCount} 个资产仍是旧版两层目录，将搬到四层布局`
              : '所有资产已是四层布局 <大类>/<一级>/<二级>/<资产名>'
          }
          actions={
            legacyLayoutCount > 0 ? (
              <button
                className="btn !py-1 text-xs"
                disabled={migBusy}
                onClick={() => {
                  setMigResult(null)
                  setMigOpen(true)
                }}
              >
                <IconRefresh />
                迁移…
              </button>
            ) : (
              /* 状态由 `legacyLayoutCount`（既有只读探测）直接判定，不猜：
                 0 = 没有旧版目录 → 无需迁移。 */
              <StatusBadge tone="ok">无需迁移</StatusBadge>
            )
          }
        />
        <SettingsRow
          title="材质大类合并"
          desc={
            materialMergeBusy
              ? '正在合并…请勿关闭应用或手动改动库目录'
              : !mergeProbed
                ? '正在检测旧目录…'
                : mergeResult
                  ? `上次合并：成功 ${mergeResult.moved} 个${mergeResult.renamed > 0 ? `，重名加序号 ${mergeResult.renamed} 个` : ''}${mergeResult.failed > 0 ? `，失败 ${mergeResult.failed} 个` : ''}`
                  : materialMergeCount > 0
                    ? `检测到 ${materialMergeCount} 个资产仍在旧目录（${materialMergeSources.map((s) => s.name).join(' / ') || '贴图 / 材质预设'}）下`
                    : '所有资产已在「材质/」下，无需处理'
          }
          actions={
            mergeProbed && materialMergeCount === 0 && !materialMergeBusy && !mergeResult ? (
              <StatusBadge tone="ok">已完成</StatusBadge>
            ) : (
              <button
                className="btn !py-1 text-xs"
                disabled={materialMergeCount === 0 || materialMergeBusy}
                onClick={async () => {
                  setMergeResult(null)
                  // force：用户在设置页显式点击 = 已知情，跳过 >50 的自动保护
                  const r = await mergeMaterial({ force: true })
                  setMergeResult({ moved: r.moved, renamed: r.renamed, failed: r.failed })
                  flash()
                }}
              >
                <IconRefresh />
                {materialMergeBusy
                  ? '合并中…'
                  : `立即合并${materialMergeCount > 0 ? `（${materialMergeCount} 个）` : ''}`}
              </button>
            )
          }
        />
      </SettingsCard>

      {/* 危险区：红描边 + 独立卡（设计语言「⑦」）。红色只允许出现在这里。 */}
      <SettingsCard title="危险操作" danger>
        <SettingsRow
          title="强制重扫"
          desc={
            <>
              仅用于确认库目录已变空 / 换库后重建索引，会弹二次确认
              {forceRemoved !== null && `（上次已移除 ${forceRemoved} 个索引记录，可恢复）`}
            </>
          }
          actions={
            <button
              className="btn btn-danger !py-1 text-xs"
              disabled={forceBusy}
              onClick={() => void openForceRescan()}
              title="跳过安全守卫重建索引（会先自动备份，仍可恢复）"
            >
              <IconRefresh />
              强制重扫
            </button>
          }
        />
      </SettingsCard>
    </div>
  )

  const dataTab = (
    <div className="flex flex-col gap-[13px]">
      <SettingsCard title="删除">
        {/* 删除撤销期三档（原话：「删除是否要等 5 秒在设置里面给用户权限」）。
            ⚠️「不等待」只取消倒计时条，**二次确认弹窗仍然在**。
            归一化后再比对：settings 被手改成 9999 时仍高亮「5 秒」而不是三个都不选中。 */}
        <SettingsRow
          title="删除撤销期"
          desc="确认删除后给多久反悔时间；选「不等待」仍会二次确认，确认后直接进回收站。"
          actions={
            <div className={SEG_GROUP_CLASS} role="radiogroup" aria-label="删除撤销期">
              {UNDO_GRACE_OPTIONS.map((opt) => {
                const active = normalizeUndoGraceMs(settings.undoGraceMs) === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={opt.hint}
                    className={segItemClass(active)}
                    onClick={() => {
                      void saveSettings({ undoGraceMs: opt.value })
                      flash()
                    }}
                  >
                    <span>{opt.label}</span>
                    {opt.value === 5000 && (
                      <span className="text-[10.5px] font-normal text-muted">默认</span>
                    )}
                  </button>
                )
              })}
            </div>
          }
        />
        <SettingsRow
          title="删除保留期"
          desc="切换不会立刻清理已删除的资产，新的保留期在下一次自动清理时生效。"
          actions={
            <div className={SEG_GROUP_CLASS} role="radiogroup" aria-label="删除保留期">
              {RETENTION_OPTIONS.map((opt) => {
                const active = settings.trashRetention === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={`${opt.label} · ${opt.hint}`}
                    className={segItemClass(active)}
                    onClick={() => {
                      void saveSettings({ trashRetention: opt.value })
                      flash()
                    }}
                  >
                    <span>{RETENTION_SHORT[opt.value]}</span>
                    {opt.value === '30d' && (
                      <span className="text-[10.5px] font-normal text-muted">默认</span>
                    )}
                  </button>
                )
              })}
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard title="缓存与索引">
        <SettingsRow
          title="缩略图缓存"
          desc={
            thumbStat
              ? `${thumbStat.count} 个文件 · ${formatBytes(thumbStat.bytes)} · 清空不影响素材，网格会按需重建`
              : '正在统计…'
          }
          actions={
            <button
              className="btn !py-1 text-xs"
              onClick={() => void clearThumbs()}
              disabled={clearing || !thumbStat}
            >
              <IconRefresh />
              {clearing ? '清空中…' : '清除缓存'}
            </button>
          }
        />
        <SettingsRow
          title="导出索引快照"
          desc="分类 / 标签 / 备注导出为 JSON，不含素材本体"
          actions={
            <button className="btn !py-1 text-xs" onClick={() => void exportIndex()}>
              导出…
            </button>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="诊断日志"
        note={
          <>
            日志只记运行信息（版本 / 错误与崩溃堆栈 / 操作）与文件路径，
            <b className="font-medium text-secondary">不含素材内容和密钥</b>
            ；导出前自动打包成 zip。
            <br />
            路径长度提示只做指引、不改注册表：资产名过长叠加深层分类目录时，可能出现移动 /
            打开失败，此时可开启系统长路径支持 —— 组策略 <code className="font-mono">gpedit.msc</code>{' '}
            → 计算机配置 → 管理模板 → 系统 → 文件系统 →「启用 Win32 长路径」，或注册表{' '}
            <code className="font-mono">LongPathsEnabled=1</code>。
          </>
        }
      >
        <SettingsRow
          title="日志文件"
          desc={
            logStat
              ? `${logStat.count} 个文件 · ${formatBytes(logStat.bytes)} · 自动保留最近 7 天`
              : '正在读取日志目录…'
          }
          notice={
            logStat ? (
              <div
                className="mt-1 truncate font-mono text-[11px] text-muted"
                title={logStat.dir}
              >
                {logStat.dir}
              </div>
            ) : null
          }
          actions={
            <>
              <button
                className="btn !py-1 text-xs"
                disabled={!logStat}
                title="在文件管理器中打开日志目录"
                onClick={() => {
                  if (logStat) void window.modvault.openPath(logStat.dir)
                }}
              >
                打开文件夹
              </button>
              <button
                className="btn !py-1 text-xs"
                disabled={logExporting || !logStat}
                onClick={() => void exportLogs()}
                title="把日志目录打包成 zip，便于发给开发者排查"
              >
                <IconRefresh />
                {logExporting ? '打包中…' : '导出日志…'}
              </button>
            </>
          }
        />
        <SettingsRow
          title="记录详细日志"
          desc="额外记录 debug 级信息（更啰嗦），复现问题后关掉"
          actions={
            <Toggle
              checked={settings.verboseLogging === true}
              onChange={(v) => {
                void saveSettings({ verboseLogging: v })
                flash()
              }}
            />
          }
        />
        {/* RA2：MAX_PATH 风险提示（只做指引，不改注册表）。
            v0.8.1 收口：这一行的摘要原本带 3 行操作步骤（gpedit / 注册表），是全弹窗
            唯一一处 >2 行的行摘要。现在摘要压成一行，步骤下沉到本卡已有的 note
            （低频参考信息，跟日志说明放一起；不新开 note、不做折叠面板）。
            ⚠️ 这一项**没有**对应的 settings 字段（纯提示），所以不给开关。 */}
        <SettingsRow
          title="路径长度提示"
          desc="超过 260 字符时提示；开启系统长路径支持可根治"
        />
      </SettingsCard>
    </div>
  )

  /**
   * 关于页「检查更新」的状态行文案（唯一来源，避免 JSX 里堆三元）。
   *
   * 优先级：检查中 > 有更新 > 失败 > 已是最新 > 尚未检查。
   * - 失败**不弹窗**，就这一行小字（用户要求"不打扰"；自动检查失败也一样）。
   * - `latest` 为空时退回"已是最新"（理论上不会发生：成功即有 tag_name）。
   */
  const updateStatusText = updateChecking
    ? '正在检查…'
    : updateInfo?.hasUpdate && updateInfo.latest
      ? `发现新版本 v${updateInfo.latest}`
      : updateInfo?.error
        ? '检查失败，可稍后重试'
        : updateInfo
          ? '已是最新版本'
          : ''

  /** 「去下载」：优先安装包直链（一键下载），没有就开 Release 页面 */
  const openUpdateDownload = () => {
    const target = updateInfo?.assetUrl || updateInfo?.url
    if (!target) return
    // 打开失败（系统无默认浏览器等）静默忽略：不下发 notice，用户可再点 Release 链接
    void window.modvault.openExternal(target).catch(() => undefined)
  }

  /** 版本状态点的颜色语义：有更新/失败不用绿点（绿点只说"已是最新"） */
  const updateOk = !updateChecking && !updateInfo?.hasUpdate && !updateInfo?.error && !!updateInfo

  const aboutTab = (
    <div className="flex flex-col gap-[13px]">
      {/* 版本与更新：横排（ID BOX + Preview 胶囊 + 版本号 + 状态点 + 立即检查），
          自动更新开关收在同一张卡的第二行。 */}
      <SettingsCard>
        <div className="flex items-center gap-3.5 py-[13px]">
          <img
            src={brandMark}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-11 w-11 shrink-0 rounded-[11px] object-contain"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[14px] font-semibold text-primary">
              ID BOX
              <span className="rounded-full bg-preview-tint px-[7px] py-[1.5px] text-[10px] font-semibold text-preview">
                Preview
              </span>
            </div>
            <div className="mt-[3px] flex items-center gap-[7px] text-[11.5px] text-muted">
              <span>v{version || '…'}</span>
              {updateStatusText && (
                <>
                  <span>·</span>
                  {updateOk && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
                  <span className={updateOk ? 'text-success' : 'text-secondary'}>
                    {updateStatusText}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-nowrap items-center gap-2">
            {updateInfo?.hasUpdate && (
              <button
                className="btn btn-primary !px-3 !py-1 text-[12px]"
                onClick={openUpdateDownload}
              >
                去下载
              </button>
            )}
            <button
              className="btn btn-ghost !px-2.5 !py-1 text-[12px] text-secondary disabled:opacity-50"
              disabled={updateChecking}
              onClick={() => void checkForUpdate({ force: true })}
              title="立即检查 GitHub 上是否有新版本"
            >
              {updateChecking && <IconRefresh className="animate-spin" />}
              {updateChecking ? '检查中…' : '立即检查'}
            </button>
          </div>
        </div>
        <SettingsRow
          title="启动时自动检查更新"
          desc="每次启动查一次 GitHub Releases；断网或失败不影响使用"
          actions={
            <Toggle
              checked={settings.autoCheckUpdate !== false}
              onChange={(v) => void saveSettings({ autoCheckUpdate: v })}
            />
          }
        />
      </SettingsCard>

      <div className="grid grid-cols-2 gap-[13px]">
        <SupportCard
          title="赞赏支持"
          qrSrc={donateQr}
          qrAlt="微信赞赏码"
          caption="这工具省了你时间的话，可以请我喝杯咖啡。"
        />
        <SupportCard
          title="反馈建议"
          qrSrc={contactQr}
          qrAlt="微信加好友二维码"
          caption="用得不顺手、想要什么功能，扫码直接跟我说。"
          footer={
            <button
              className="inline-flex items-center rounded-[8px] border border-accent/30 bg-accent-tint px-2.5 py-[5px] text-[12px] text-accent-text transition hover:bg-accent-tint/70"
              onClick={async () => {
                // `openExternal` **永不 reject**：成功 true / 被拒或失败 false
                // （主进程只放行 https: / http:，长度上限 2048，控制字符拒）。
                // 所以拿返回值判断，不把 .catch 当主判据。
                const ok = await window.modvault.openExternal(GITHUB_ISSUES_URL)
                if (!ok) {
                  useVault.setState({
                    notice: '链接打开失败，可手动访问 github.com/chengcheng067/ID-BOX/issues'
                  })
                }
              }}
              title={GITHUB_ISSUES_URL}
            >
              在 GitHub 提 Issue ↗
            </button>
          }
        />
      </div>

      <div className="pt-1 text-center text-[11px] text-muted">
        MIT License · 本地离线运行 · 数据不出设备
      </div>
    </div>
  )


  // 强制重扫弹窗里的数字：未取到预览时用 0 兜底（该分支只在 preview 就绪时渲染）
  const forceGone = forcePreview?.gone ?? 0
  const forceTotal = forcePreview?.total ?? 0
  const forceFound = forcePreview?.found ?? 0

  /** 当前 tab 的页头文字：标题取 `TABS`（唯一真源），副标题取 `TAB_SUB` */
  const currentTabLabel = TABS.find((t) => t.key === tab)?.label ?? '设置'

  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex items-center justify-center p-6`}
      onClick={onClose}
    >
      {/* 走查 v0.2.2 B4 拍板：弹窗圆角分组件 —— 设置弹窗 16（画布 2:479/2:541），
          渲染弹窗 12（画布 2:242）；深色四屏一致 14（2:842/2:879/2:935/2:1024），由 --radius-modal-settings 的深色覆盖承担。 */}
      {/* 尺寸（v0.8.1 用户拍板 900×680）：原来的 760×560 装不下「一张卡 = 一个心智单元」
          的卡片流，几乎每个 tab 都要滚。900×680 让 7 个 tab 里绝大多数一屏看完。
          `max-h` / `max-w` 是**小屏兜底**（1280×720 这类）：遮罩层 p-6 只有 24px 安全边距，
          900×680 在 720 高的屏上会顶到边，加 max-* 让它按视口收缩，
          而不是把 ✕ 顶出可视区 —— 页头是 `shrink-0`、在滚动容器之外，所以永远可见。 */}
      <div
        className="flex h-[680px] max-h-[calc(100vh-48px)] w-[900px] max-w-[calc(100vw-48px)] overflow-hidden rounded-modal-settings border border-panel-line bg-card shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左栏导航：分组标题（偏好 / 素材 / 数据 / 其他，10.5px + letter-spacing .1em），
            版本号固定在**左下角**（`mt-auto`）。 */}
        <aside className="flex w-[172px] shrink-0 flex-col bg-sidebar px-3.5 pb-4 pt-6">
          <div className="px-2.5 pb-5 text-[18px] font-semibold text-primary">设置</div>
          <nav className="flex flex-col">
            {TAB_GROUPS.map((group) => (
              <div key={group.label} className="mb-[18px]">
                <div className="px-2.5 pb-[7px] text-[10.5px] font-semibold tracking-[0.1em] text-muted">
                  {group.label}
                </div>
                <div className="flex flex-col gap-0.5">
                  {group.keys.map((key) => {
                    const item = TABS.find((t) => t.key === key)
                    if (!item) return null
                    const active = tab === key
                    // C#12（已拍板单立一档 8，两主题同值）：tab 项不能复用 --radius-nav
                    // （浅 9 / 深 7），走独立 --radius-tab。
                    return (
                      <button
                        key={key}
                        className={`flex h-[33px] items-center rounded-tab px-2.5 text-[13px] transition ${
                          active
                            ? 'bg-accent-tint font-medium text-accent-text'
                            : 'text-secondary hover:bg-elevated/60'
                        }`}
                        onClick={() => setTab(key)}
                      >
                        {item.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
          <div className="mt-auto px-2.5 text-[11px] text-muted">{version ? `v${version}` : ''}</div>
        </aside>

        {/* 右内容区：页头（17/600 + 12 副标题 + ✕） + 卡片流 */}
        <div className="flex min-w-0 flex-1 flex-col bg-canvas">
          <PageHeader
            title={currentTabLabel}
            sub={TAB_SUB[tab]}
            onClose={onClose}
            saved={saved}
          />
          {/* 内容区：外层 relative 只是为了给底部渐隐条做定位锚（见 tabHasMore 的注释） */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={tabScrollRef}
              onScroll={syncTabOverflow}
              className="flex-1 overflow-auto px-8 pb-[22px]"
            >
              <div>
                {tab === 'appearance' && appearanceTab}
                {tab === 'import' && importTab}
                {tab === 'classify' && classifyTab}
                {tab === 'library' && libraryTab}
                {tab === 'alias' && <AliasTab />}
                {tab === 'data' && dataTab}
                {tab === 'about' && aboutTab}
              </div>
            </div>
            {tabHasMore && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-canvas to-transparent"
              />
            )}
          </div>
        </div>
      </div>

      {/* 强制重扫确认弹窗：数字必须真实、后果必须写清、必须显式勾选 */}
      {forceOpen && (
        <Modal title="强制重扫（允许清空索引）" onClose={() => !forceBusy && setForceOpen(false)} width="max-w-md">
          {forceBusy || (!forcePreview && !forceError) ? (
            <p className="text-[13px] leading-relaxed text-muted">正在检查磁盘与索引的差异…</p>
          ) : forceError ? (
            <>
              <p className="text-[13px] leading-relaxed text-danger">{forceError}</p>
              <div className="mt-4 flex justify-end">
                <button className="btn" onClick={() => setForceOpen(false)}>
                  关闭
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed">
                {forceGone > 0 ? (
                  <>
                    本次将删除索引中{' '}
                    <span className="font-semibold text-danger">{forceGone}</span> 个在磁盘上
                    找不到的资产（当前索引 {forceTotal} 个，磁盘上找到 {forceFound} 个）。
                  </>
                ) : (
                  <>
                    当前索引 {forceTotal} 个资产在磁盘上都能找到，强制重扫<b>不会删除任何记录</b>。
                  </>
                )}
              </p>
              {forceGone > 0 ? (
                <p className="mt-2 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[12px] leading-relaxed text-danger">
                  被删除资产中的<b>标签、备注、风格会丢失</b>——这些数据只存在于索引里，磁盘上没有副本。
                </p>
              ) : (
                <p className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] leading-relaxed text-muted">
                  索引与磁盘当前一致，本次不会删除任何记录（重扫只是重建索引）。
                </p>
              )}
              <p className="mt-2 text-[12px] leading-relaxed text-muted">
                删除前会自动写入一份完整备份；确认后仍可用「恢复上次重扫前索引」救回（磁盘文件需你自己放回原位）。
              </p>
              <CheckRow
                checked={forceAck}
                onChange={setForceAck}
                align="start"
                className="mt-3 leading-relaxed"
              >
                <span>
                  {forceGone > 0
                    ? '我已了解标签 / 备注 / 风格会丢失，仍要强制重扫'
                    : '我已了解，确认强制重扫'}
                </span>
              </CheckRow>
              <div className="mt-4 flex justify-end gap-2">
                <button className="btn" onClick={() => setForceOpen(false)}>
                  取消
                </button>
                <button
                  className="btn btn-outline-danger"
                  disabled={!forceAck}
                  onClick={async () => {
                    setForceBusy(true)
                    try {
                      const r = await forceRescanAction()
                      setForceRemoved(r.removed)
                      setForceOpen(false)
                    } catch {
                      // 失败不静默：留在弹窗里说明原因（索引可能未被改动）
                      setForceError('强制重扫失败：库目录不可读或写入被拒绝，索引未清空。')
                    } finally {
                      setForceBusy(false)
                      void refreshRescanBackupCount()
                    }
                  }}
                >
                  {forceGone > 0 ? `确认删除 ${forceGone} 个并重扫` : '确认重扫'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* v0.4 一致性报告弹窗：默认全部不勾（只读检查 → 用户显式选择才修） */}
      {report && (
        <Modal
          title="库一致性报告"
          onClose={() => {
            if (!applyBusy) setReport(null)
          }}
          width="max-w-2xl"
        >
          <div className="text-[12px] text-secondary">
            扫描到 <span className="font-semibold text-primary">{report.scannedCount}</span> 项 ·
            索引 <span className="font-semibold text-primary">{report.indexCount}</span> 项
          </div>

          {isReconcileClean(report) ? (
            <p className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-secondary">
              索引与磁盘一致，没有发现问题。
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-1 text-[12px] leading-relaxed text-secondary">
                <li>
                  磁盘上找不到{' '}
                  <span className="font-semibold text-primary">
                    {report.counts['missing-on-disk']}
                  </span>{' '}
                  项
                </li>
                <li>
                  未索引{' '}
                  <span className="font-semibold text-primary">
                    {report.counts['not-in-index']}
                  </span>{' '}
                  项
                </li>
                <li>
                  分类不一致{' '}
                  <span className="font-semibold text-primary">
                    {report.counts['category-mismatch']}
                  </span>{' '}
                  项
                </li>
              </ul>

              {/* 明细最多 20 条（超出只报数量，避免弹窗无限长） */}
              <div className="mt-3 max-h-60 overflow-auto rounded-lg border border-line bg-canvas">
                {report.items.slice(0, 20).map((item) => (
                  <div
                    key={`${item.kind}:${item.folder}`}
                    className="border-b border-line/60 px-3 py-2 last:border-0"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className="min-w-0 truncate text-[12px] font-medium text-primary"
                        title={item.folder}
                      >
                        {item.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">{DIFF_LABEL[item.kind]}</span>
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-muted"
                      title={relDirOf(item.folder)}
                    >
                      {relDirOf(item.folder)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-secondary">{reasonOf(item)}</div>
                  </div>
                ))}
                {report.items.length > 20 && (
                  <div className="px-3 py-2 text-[11px] text-muted">
                    还有 {report.items.length - 20} 条…
                  </div>
                )}
              </div>

              {/* 三个勾选项默认全 false：勾选后才会修改（自绘控件，不用系统默认控件） */}
              <div className="mt-3 space-y-1.5">
                <p className="text-[11px] text-tertiary">勾选后才会修改（默认全部不勾）：</p>
                <CheckRow
                  checked={pickMissing}
                  disabled={report.counts['missing-on-disk'] === 0}
                  onChange={setPickMissing}
                >
                  <span>移除索引中磁盘已不存在的 {report.counts['missing-on-disk']} 项</span>
                </CheckRow>
                <CheckRow
                  checked={pickNotIndexed}
                  disabled={report.counts['not-in-index'] === 0}
                  onChange={setPickNotIndexed}
                >
                  <span>把磁盘上已有的 {report.counts['not-in-index']} 项补入索引</span>
                </CheckRow>
                <CheckRow
                  checked={pickMismatch}
                  disabled={report.counts['category-mismatch'] === 0}
                  onChange={setPickMismatch}
                >
                  <span>按磁盘目录名修正 {report.counts['category-mismatch']} 项分类</span>
                </CheckRow>
                <p className="text-[10px] leading-relaxed text-muted">
                  移除索引前会自动备份被删记录（可从「恢复上次重扫前索引」找回），素材文件本身不会被删除。
                </p>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button className="btn" disabled={applyBusy} onClick={() => setReport(null)}>
                  取消
                </button>
                <button
                  className="btn btn-primary"
                  disabled={applyBusy || pickedCount === 0}
                  title={pickedCount === 0 ? '请先勾选要执行的修复类别' : '执行所选修复'}
                  onClick={() => void runRepair()}
                >
                  {applyBusy ? '修复中…' : '执行所选修复'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* 迁移确认弹窗：数字必须写清楚 */}
      {migOpen && (
        <Modal title="确认迁移旧版目录" onClose={() => !migBusy && setMigOpen(false)} width="max-w-md">
          <p className="text-[13px] leading-relaxed">
            将把 <span className="font-semibold text-danger">{legacyLayoutCount}</span>{' '}
            个资产目录从「大类/资产名」搬到「大类/未分类/未分类/资产名」。
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            这是批量搬动磁盘真实文件的操作（可能涉及 GB 级素材），过程中请不要关闭应用或手动改动库目录。
            目标位置已有同名目录时自动追加序号，永不覆盖；索引中的标签与备注会保留。
          </p>
          {migResult ? (
            <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px]">
              迁移完成：成功 <span className="font-semibold text-success">{migResult.moved}</span> 个
              {migResult.failed > 0 && (
                <>
                  ，失败 <span className="font-semibold text-danger">{migResult.failed}</span> 个
                </>
              )}
              。
            </div>
          ) : (
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setMigOpen(false)} disabled={migBusy}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={migBusy}
                onClick={async () => {
                  setMigBusy(true)
                  const r = await migrateLegacyLayout().catch(() => ({ moved: 0, failed: -1 }))
                  setMigBusy(false)
                  setMigResult(r)
                  flash()
                }}
              >
                {migBusy ? '迁移中…' : `开始迁移（${legacyLayoutCount} 个）`}
              </button>
            </div>
          )}
          {migResult && (
            <div className="mt-3 flex justify-end">
              <button className="btn" onClick={() => setMigOpen(false)}>
                关闭
              </button>
            </div>
          )}
        </Modal>
      )}

      {/* v1.0.13 重跑自动分类确认弹窗：数字写清楚（会真实搬目录） */}
      {reclassOpen && (
        <Modal
          title="确认重跑自动分类"
          onClose={() => {
            if (!reclassifyBusy) setReclassOpen(false)
          }}
          width="max-w-md"
        >
          <p className="text-[13px] leading-relaxed">
            将处理{' '}
            <span className="font-semibold text-danger">{unclassifiedCount}</span> 个
            「未分类/未分类」的资产：
            <span className="text-secondary">
              按当前词表重新判定，命中的会<b>真实移动目录</b>到对应分类（已分类的资产不受影响）。
            </span>
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            移动前会自动写一份备份（只保留最近 3 份），跑完后可在设置页点「撤销上次重跑」按原分类搬回。
            过程中请不要关闭应用或手动改动库目录。
          </p>
          {reclassResult ? (
            <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px]">
              重跑完成：移动{' '}
              <span className="font-semibold text-success">{reclassResult.moved}</span> 个，未识别{' '}
              <span className="font-semibold">{reclassResult.missed}</span> 个
              {reclassResult.failed > 0 && (
                <>
                  ，失败 <span className="font-semibold text-danger">{reclassResult.failed}</span> 个
                </>
              )}
              。
            </div>
          ) : (
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setReclassOpen(false)} disabled={reclassifyBusy}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={reclassifyBusy || unclassifiedCount === 0}
                onClick={async () => {
                  const r = await reclassifyUnclassified()
                  setReclassResult(r)
                  void refreshReclassBackupCount()
                  flash()
                }}
              >
                {reclassifyBusy ? '处理中…' : `开始重跑（${unclassifiedCount} 个）`}
              </button>
            </div>
          )}
          {reclassResult && (
            <div className="mt-3 flex justify-end">
              <button className="btn" onClick={() => setReclassOpen(false)}>
                关闭
              </button>
            </div>
          )}
        </Modal>
      )}

      {/* 知末「按站方分类重排」确认弹窗（结构照「重跑自动分类」那条）：
          候选数写清楚，并明确"会真实搬目录"与"取消 ≠ 回滚"。 */}
      {zhimoReclassOpen && (
        <Modal
          title="确认按站方分类重排"
          onClose={() => {
            if (!zhimoReclass.running) setZhimoReclassOpen(false)
          }}
          width="max-w-md"
        >
          <p className="text-[13px] leading-relaxed">
            将处理 <span className="font-semibold text-danger">{zhimoCandidateCount}</span> 个
            「未分类」且带知末 ID 的资产：
            <span className="text-secondary">
              按知末详情页上的站方分类把它们搬到对应分类目录（
              <b>会真实移动磁盘上的目录</b>；已分类的资产一律不动）。
            </span>
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            移动前会自动写一份备份（只保留最近 3 份），跑完后可在设置页点「撤销上次知末重排」按原分类搬回。
            过程需要逐条访问知末详情页，可能持续几分钟；请不要关闭应用或手动改动库目录。
          </p>
          {zhimoProgressBlock}
          {zhimoResultBlock}
          {!zhimoReclass.running && !zhimoReclassResult && (
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setZhimoReclassOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={zhimoCandidateCount === 0}
                onClick={async () => {
                  setZhimoCancelled(false)
                  setZhimoReclassResult(null)
                  const r = await runZhimoCategoryReclass({ manual: true })
                  setZhimoReclassResult(r)
                  void refreshZhimoReclassBackupCount()
                  flash()
                }}
              >
                开始重排（{zhimoCandidateCount} 个）
              </button>
            </div>
          )}
          {zhimoReclassResult && !zhimoReclass.running && (
            <div className="mt-3 flex justify-end">
              <button className="btn" onClick={() => setZhimoReclassOpen(false)}>
                关闭
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
