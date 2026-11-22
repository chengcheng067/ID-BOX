/**
 * SketchUp 插件的**安装情况判定**（2026-11-23 用户拍板修复）—— 纯逻辑层。
 *
 * ## 为什么需要它
 *
 * 1.0.x 的「已安装」判据是 `%APPDATA%\idbox\plugin\manifest.json` 存在可解析 —— 而那是
 * **本体自己写的**索引快照（`main/pluginExport.ts`）。等于"我自己写过索引"就宣布装了插件：
 * 插件根本没装也显示已安装，按钮还变灰不可点，用户连升级入口都没有。
 *
 * 现在的判据改成**扫真机**：直接去 SketchUp 的 `Plugins` 目录找 `idbox_panel.rb`
 * （或 `idbox_panel/lib/core.rb`）并解析里面的版本常量，和本体自带的版本（= `app.getVersion()`，
 * 与 `plugin-src` 的 `EXT_VERSION` / `PLUGIN_VERSION` 四处同值）比较，得出四态：
 *
 * - `missing`：没装 → 给「安装插件」按钮；
 * - `installed`：同版本 → 灰胶囊「已安装 vX」；
 * - `outdated`：真机旧 → 给「更新到 X」主按钮（导出 rbz，由用户在扩展管理器覆盖安装）；
 * - `ahead`：真机比本体新（用户手动装过更新的）→ 灰胶囊，不给降级入口。
 *
 * 多台机器装了不同版本时，**整体状态按"任一台旧就算旧"判**（`decideSummaryState`）：
 * 只看最高版本会把旧的那台藏起来，用户就再也没有更新入口了。
 *
 * ## 边界
 *
 * 本文件**零 IO、零 node: import、零 electron**（`shared/` 里的模块要能被渲染层 import，
 * 渲染层没有 Node 能力 —— `README.md:285`、preload 全文无 `node:fs`）。
 * 目录枚举与读盘在 `src/main/pluginScan.ts`（IO 层），这里只做字符串与比较。
 */

/** 插件安装四态（UI 右侧控件按它分支） */
export type PluginInstallState = 'missing' | 'installed' | 'outdated' | 'ahead'

/** 一台 SketchUp 上的命中（`sketchup` 是目录名，如 `SketchUp 2025`） */
export interface InstalledPluginHit {
  sketchup: string
  /** 解析到的版本；文件在但解析不出 → null（诚实：装了个来路不明的） */
  version: string | null
}

/** 一屏所需的全部信息（IPC 一次传够，渲染层不再自己算） */
export interface PluginInstallStatus {
  /** 本体自带的插件版本（= `app.getVersion()`，与 plugin-src 同值） */
  shippedVersion: string
  /** 版本降序；`version: null` 的排最后 */
  hits: InstalledPluginHit[]
  /** `hits` 里最高的有效版本；全为 null / 无命中 → null */
  installedVersion: string | null
  state: PluginInstallState
}

/**
 * 进解析的**上限**（字节级近似：按 UTF-16 码元数算，够用）。
 *
 * 插件根文件 / core.rb 都是几十 KB 以内的小文件；超长说明拿错了文件，
 * 直接不解析（调用方仍会截断读盘，这里是第二道闸）。
 */
export const PLUGIN_VERSION_LITERAL_LIMIT = 64 * 1024

/** 根注册文件里的扩展元数据版本（`Registrar::EXT_VERSION`） */
const EXT_VERSION_RE = /EXT_VERSION\s*=\s*['"]([^'"]+)['"]/

/** 支持目录里的插件版本（`IDBoxPanel::PLUGIN_VERSION`） */
const PLUGIN_VERSION_RE = /PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/

/** 版本字面量形态：`1` / `1.1` / `1.1.0`；其它一律不信 */
const VERSION_SHAPE_RE = /^\d+(\.\d+)*$/

/**
 * 从 Ruby 源码**原文**解析插件版本。
 *
 * 规则（顺序不能变）：
 * 1. **先按行剔掉注释行**（`^\s*#`）—— 这两个 .rb 的注释里就写着「1.1.0 → 1.1.1」这类
 *    升级指引，不剔会把注释里的假赋值当真；
 * 2. 先找 `EXT_VERSION = '...'`，没有再找 `PLUGIN_VERSION = '...'`；
 * 3. 抓到的值必须形如 `^\d+(\.\d+)*$`，否则 null（`'abc'` / `''` / `.freeze` 抓错都算坏）。
 *
 * 空串 / 非字符串 / 超过 `PLUGIN_VERSION_LITERAL_LIMIT` → null，**永不抛异常**。
 */
export function parsePluginVersionLiteral(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (raw.length > PLUGIN_VERSION_LITERAL_LIMIT) return null

  // 只留非注释行：注释里的 `EXT_VERSION = '0.0.1'` 是说明文字，不是真相
  const code = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  const m = EXT_VERSION_RE.exec(code) ?? PLUGIN_VERSION_RE.exec(code)
  if (!m) return null
  const value = m[1].trim()
  return VERSION_SHAPE_RE.test(value) ? value : null
}

/** 单段转数字：非法段当 0（`1.x` 与 `1.0` 同权，不制造意外的大小关系） */
function segmentToNumber(segment: string | undefined): number {
  if (typeof segment !== 'string') return 0
  const text = segment.trim()
  if (!/^\d+$/.test(text)) return 0
  const value = Number(text)
  return Number.isFinite(value) ? value : 0
}

/**
 * 版本比较：`> 0` 表示 a 更新，`< 0` 表示 b 更新，`0` 表示相等。
 *
 * 按 `.` 切段逐段比数字；段数不同时缺的当 0（`1.1` == `1.1.0`）；非法段当 0。
 * 不引任何依赖（semver 包不在依赖里，也不该为这一行逻辑加）。
 */
export function compareVersions(a: string, b: string): number {
  const left = typeof a === 'string' ? a.split('.') : []
  const right = typeof b === 'string' ? b.split('.') : []
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = segmentToNumber(left[i])
    const y = segmentToNumber(right[i])
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 四态判定：没装 → missing；同版本 → installed；真机旧 → outdated；真机新 → ahead */
export function decidePluginInstallState(
  shipped: string,
  installed: string | null
): PluginInstallState {
  if (typeof installed !== 'string' || installed.length === 0) return 'missing'
  const diff = compareVersions(installed, shipped)
  if (diff === 0) return 'installed'
  return diff < 0 ? 'outdated' : 'ahead'
}

/**
 * 按**全部命中**判定整体状态（2026-11-23 用户拍板纠正）。
 *
 * 单版本判据（`decidePluginInstallState`）不够用：用户本机是
 * `[2024:1.0.5, 2025:1.1.0]`，只看最高版本会得出 `installed` ⇒ 按钮变灰胶囊，
 * **2024 那份旧插件永远没有更新入口** —— 而这正是用户这一轮报的原始痛点。
 * 所以整体状态按"任一台旧就算旧"判：有更新入口，用户才修得掉那台旧的。
 *
 * 规则（顺序即优先级）：
 * 1. 没有命中 → `missing`；
 * 2. 命中但**一个有效版本都没有**（全是 null）→ `installed`（装了但认不出版本：
 *    **不许误报未安装**，也不诱导覆盖）；
 * 3. 存在任一有效版本 `< shipped` → `outdated`（哪怕另一台已是新版）；
 * 4. 所有有效版本都 `> shipped` → `ahead`；
 * 5. 其余（全等于 / 有等于有高于）→ `installed`。
 */
export function decideSummaryState(
  shipped: string,
  hits: readonly InstalledPluginHit[]
): PluginInstallState {
  const list = Array.isArray(hits) ? hits.filter((hit): hit is InstalledPluginHit => !!hit) : []
  if (list.length === 0) return 'missing'
  const versions = list
    .map((hit) => hit.version)
    .filter((version): version is string => typeof version === 'string' && version.length > 0)
  if (versions.length === 0) return 'installed'
  if (versions.some((version) => compareVersions(version, shipped) < 0)) return 'outdated'
  if (versions.every((version) => compareVersions(version, shipped) > 0)) return 'ahead'
  return 'installed'
}

/**
 * 汇总一次扫描：排序（版本降序、未知版本垫底）+ 取最高版本 + 出四态。
 *
 * - `installedVersion` 仍是**最高有效版本**（纯展示用：胶囊文案 / 更新 title 里的"当前装的"）；
 * - `state` 改由 `decideSummaryState` 按**全部命中**判（任一台旧 ⇒ outdated），
 *   不能让"最高那台是新的"掩盖另一台的旧版本。
 *
 * **不改入参**（拷贝后排序），调用方拿到的 `hits` 已是展示顺序。
 */
export function summarizeInstallStatus(
  shipped: string,
  hits: readonly InstalledPluginHit[]
): PluginInstallStatus {
  const list = Array.isArray(hits)
    ? hits.filter((hit): hit is InstalledPluginHit => !!hit && typeof hit.sketchup === 'string')
    : []
  const sorted = [...list].sort((a, b) => {
    if (a.version === null && b.version === null) return 0
    if (a.version === null) return 1
    if (b.version === null) return -1
    return compareVersions(b.version, a.version)
  })
  const top = sorted.find((hit) => hit.version !== null)
  const installedVersion = top ? top.version : null
  return {
    shippedVersion: shipped,
    hits: sorted,
    installedVersion,
    state: decideSummaryState(shipped, sorted)
  }
}
