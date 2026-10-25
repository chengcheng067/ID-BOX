/**
 * 「索引路径 vs 当前库目录」漂移体检（纯函数，可单测）。
 *
 * ## 为什么需要它（DEF-19-3）
 *
 * `main/index.ts` 的 `asset:probeSizes` 守卫要求：资产 `folder` resolve 后必须在
 * `settings.libraryDir` 之内，越界一律 `return []`（只落一行
 * `probe-sizes:rejected-outside-library` 的 WARN）。
 *
 * 守卫本身**是对的**（越界不该读盘）。问题在于用户改过 / 搬过库目录之后：
 * DB 里老资产的 `folder` 还指向旧根 → 尺寸回填 `scanned:N, patched:0` →
 * **分辨率筛选永远是空的，而界面上没有任何解释**。实测证据见
 * `docs/08-测试报告.md` §19.6 DEF-19-3（57 条 WARN，改指副本后 `patched:52`）。
 *
 * 本模块只做一件事：把「有多少活资产的索引路径已经不在当前库目录下」算出来，
 * 交给两个提示面（设置页 / 分辨率浮层）显示。**不读写任何全局状态**，
 * `libraryDir` 由调用方传入 —— 这样既没有副作用，也不会在设置未就绪时误报。
 *
 * ## 判据复用（刻意不重写，避免两套口径漂移）
 *
 * - 路径包含判定：`logic/libraryPath.ts` 的 `isInsideLibrary`（大小写不敏感、
 *   `\`/`/` 混用、尾部多余分隔符、`root + 分隔符` 前缀判定挡住 `Library2` 陷阱）；
 * - 「缺尺寸」判定：`logic/sizeBackfill.ts` 的 `isBackfillCandidate` /
 *   `needsSizeProbe` —— 与真正跑回填的调度器同一份口径。
 */

import type { Asset } from '../../shared/types'
import type { ResolutionBucket } from './filters'
import { isInsideLibrary, normalizeWinPath } from './libraryPath'
import { isBackfillCandidate, needsSizeProbe } from './sizeBackfill'

/** 库目录漂移体检结果（两个计数都只统计**未软删**的资产） */
export interface LibraryDrift {
  /** 活资产（未软删）的 `folder` 不在 `libraryDir` 下的**资产**条数 */
  outsideCount: number
  /**
   * 上述资产里，仍存在「该探但没探到」尺寸的**文件**条数
   * （= 分辨率筛选会漏掉的文件数）。
   *
   * 只统计「分辨率有意义」的大类（`isBackfillCandidate` 同一口径）：
   * model / other 视图根本没有分辨率入口，把它们算进来只会让数字变大而无法行动。
   */
  stalledFileCount: number
}

/** 零值常量：设置未就绪 / 非法库目录时统一返回它（宁可沉默，也不能误报） */
const NO_DRIFT: LibraryDrift = { outsideCount: 0, stalledFileCount: 0 }
/**
 * 把 `.` / `..` 段就地折叠（Windows 语义），其余原样保留。
 *
 * **为什么不直接用 `libraryPath.normalizeWinPath`**：它只统一分隔符 / 去尾部
 * 分隔符 / 转小写，**不折叠 `..`**。而 `E:\Lib\sub\..\sub2` 这类写法在 Windows
 * 上是合法的（同一目录的另一种写法），不折叠就会把「库内」误判成「库外」，
 * 正好制造我们要消灭的假警告。所以先在本模块内折叠段，再交给
 * `isInsideLibrary` 做大小写 / 分隔符 / 前缀的最终判定 —— 两段职责分明。
 *
 * 绝对路径的 `..` 弹到根就停（`E:\..` 仍是 `E:\`）；相对路径的 `..` 弹不掉时
 * 原样保留（这种路径永远不会被判成「在库内」，符合预期）。
 */
function resolveDotSegments(p: string): string {
  const unified = p.trim().replace(/\//g, '\\')
  if (unified === '') return ''
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? ''
  const isUnc = drive === '' && unified.startsWith('\\\\')
  const rest = (drive ? unified.slice(drive.length) : unified).replace(/^\\+/, '')

  const stack: string[] = []
  for (const seg of rest.split('\\')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (drive === '' && !isUnc) stack.push('..')
      continue
    }
    stack.push(seg)
  }

  const joined = stack.join('\\')
  if (drive !== '') return `${drive}\\${joined}`
  if (isUnc) return `\\\\${joined}`
  return joined
}

/** 库目录是否可用于判定（空串 / 纯空白 / 非字符串一律视为「设置未就绪」） */
function usableLibraryDir(libraryDir: unknown): string {
  if (typeof libraryDir !== 'string') return ''
  const resolved = resolveDotSegments(libraryDir)
  return normalizeWinPath(resolved) === '' ? '' : resolved
}

/** 该资产是否已被软删（`deletedAt` 有值 = 在回收站里） */
function isSoftDeleted(asset: Asset): boolean {
  return asset.deletedAt !== undefined && asset.deletedAt !== null
}

/**
 * 体检：索引里的资产路径有多少条不在当前库目录下，其中多少条因此缺尺寸。
 *
 * 纯函数 —— 同样的 `assets + libraryDir` 必然得到同样的结果；不抛异常
 * （入参是脏数据时退化为全 0，绝不把异常抛给渲染路径）。
 */
export function planLibraryDrift(assets: Asset[], libraryDir: string): LibraryDrift {
  const root = usableLibraryDir(libraryDir)
  // 设置还没读到 / 库目录为空：此时任何比较都会把整库判成「库外」，
  // 那是**误报**，比不提示更糟（会吓到刚装好的用户）。直接沉默。
  if (root === '') return { ...NO_DRIFT }
  if (!Array.isArray(assets) || assets.length === 0) return { ...NO_DRIFT }

  // 库根先折叠再交给包含判定（调用方传进来的可能是 `E:/Lib/` 这种写法）
  const resolvedRoot = resolveDotSegments(root)

  let outsideCount = 0
  let stalledFileCount = 0

  for (const asset of assets) {
    if (!asset || typeof asset.folder !== 'string' || asset.folder === '') continue
    if (isSoftDeleted(asset)) continue
    if (isInsideLibrary(resolvedRoot, resolveDotSegments(asset.folder))) continue

    outsideCount += 1
    // 「该探但没探到」与回填调度器同一口径：大类必须分辨率有意义、且确实有缺 w/h 的文件。
    // 不调 `missingSizeRels()` 是因为它会按 `BACKFILL_PROBE_LIMIT`(200) 截断 ——
    // 单个资产的缺尺寸文件超过 200 条时数字会偏小，而这里要的是真实条数。
    if (!isBackfillCandidate(asset)) continue
    const files = Array.isArray(asset.files) ? asset.files : []
    for (const file of files) {
      if (needsSizeProbe(file)) stalledFileCount += 1
    }
  }

  return { outsideCount, stalledFileCount }
}

// ── 两个提示面「显不显示 / 显示什么」的裁决（纯函数，UI 只负责渲染） ──────
//
// 为什么把文案也放这里：本仓库的 vitest 是 **node 环境**（没有 jsdom / RTL），
// 组件树渲染不了。把"何时显示 + 显示哪句话"抽成纯函数之后，
// ① 单测能直接证明「DB 里 folder 指向旧路径 + settings 指向新路径 → 提示出现」；
// ② 设置页与分辨率浮层**共用同一个裁决**，不会各写一套判据而漂移；
// ③ 组件里只剩一个 `&&`，删掉/改坏立刻会被源码守卫断言抓到。

/** 设置页警示条的内容（`null` = 整块不渲染，保证零视觉噪音） */
export interface LibraryDriftWarning {
  /** 主句：有 N 个资产的索引路径不在当前库目录内 */
  title: string
  /** 副句：说明后果 + 唯一的可行动入口（只读检查，不是"点了就删数据"） */
  body: string
}

/**
 * 设置页「库目录」那一行的警示条内容。
 *
 * 文案要求（用户看不懂技术词）：
 * - 主句说清**数量**与**事实**（索引路径不在当前库目录内）；
 * - 副句说清**后果**（分辨率采集不上来 → 中栏筛选筛不到）+ **怎么查**。
 *
 * 行动指向只读的「检查索引与磁盘」（设置 → 导入页），**不给**一键重建/删除按钮：
 * 重建索引会丢标签/备注/风格，必须先看对比结果再决定。
 */
export function libraryDriftWarning(drift: LibraryDrift | null | undefined): LibraryDriftWarning | null {
  const count = drift?.outsideCount ?? 0
  if (count <= 0) return null
  return {
    title: `有 ${count} 个资产的索引路径不在当前库目录内`,
    body:
      '这些资产的分辨率采集不上来，中栏的「分辨率」筛选会筛不到它们。' +
      '换过库目录的话，先到「导入」页点「检查索引与磁盘」按结果再决定是否重建索引。'
  }
}

/** 分辨率浮层就近提示的上下文 */
export interface ResolutionDriftHintContext {
  /** 当前生效的分辨率档位；`null` = 「不限」（列表空只能是别的原因，不该归咎于尺寸） */
  minResolution: ResolutionBucket | null
  /** 当前筛选下的可见资产数（直接传 `useVisibleAssets()` 的长度，不另算一套筛选） */
  visibleCount: number
  /** 是否在「最近删除」视图（回收站里空是正常的，不该提示） */
  inTrash: boolean
}

/**
 * 分辨率浮层底部那行小字（`null` = 不渲染）。
 *
 * 触发条件三项同时成立：真的选了档位、当前可见结果为 0、索引里有路径漂移的活资产。
 * 只说"可能"，不承诺因果 —— 空列表也可能是别的筛选造成的，但用户至少知道
 * "有一批尺寸没采到"，而不是以为库里真的没这个档位的货。
 */
export function resolutionDriftHint(
  drift: LibraryDrift | null | undefined,
  ctx: ResolutionDriftHintContext
): string | null {
  const count = drift?.outsideCount ?? 0
  if (count <= 0) return null
  if (ctx.minResolution === null) return null
  if (ctx.visibleCount > 0) return null
  if (ctx.inTrash) return null
  return `有 ${count} 个资产的尺寸没能采集，可能就藏在这里面`
}
