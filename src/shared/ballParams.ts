/**
 * 材质球调参的**纯计算**基座（docs/12 §1.3 / §3，T01）——零 electron / 零 three /
 * 零 DOM，可在 vitest node 环境直测（与 `shared/thumb.ts:2` 的纪律一致）。
 *
 * 这里放的是「运行时值 + hash 规则」，不是纯类型：`DEFAULT_PARAM_SCALES`、
 * `clampScale`、`clampUv`、`normalizeParams`、`paramsKey` 都是函数值，
 * 所以不能塞进 `shared/types.ts`（那是纯类型文件）。
 *
 * **为什么必须在 shared**：hash 由主进程（`main/ballThumb.ts`）与渲染进程
 * （`renderer/store.ts`）两处独立算出。任何一侧自行拼字符串都会导致
 * 「渲染的文件名 ≠ store 期望的文件名」→ 网格读不到图（docs/12 §10 第一条）。
 * 因此本文件是 hash 的**唯一实现**，两侧都从这里取。
 *
 * 缓存文件名格式硬约束（docs/12 §3.2）：仍是 `<id>-<8位hex>.png`，
 * 参数串**只能进 hash，不能进文件名字面**——`parseThumbFileName` 的贪婪 `.+`
 * 会把最后一个 `-` 之前全部当 id，任何非十六进制的参数串会让整套缓存管理失效。
 *
 * **为什么是 PNG 而不是 JPG**：球图缩略图必须带**透明背景**——JPEG 没有 alpha
 * 通道，只能把背景色烤进像素（历史上烤的是 `paperColor()` 纸色，深色主题下
 * 就是一块亮白方块）。透明 PNG 让卡片的 `bg-canvas` 透出来，于是
 * **深浅两个主题共用同一个缓存文件都正确**，缓存与主题彻底解耦。
 */
import type { Asset, BallSlots } from './types'
import { PBR_SLOT_ORDER } from './pbrSlots'

/**
 * 调参渲染的**三个用户可调参数**（需求书 §3.3 前两版 + v0.2.1 增补 2 第三个）：
 * - `roughness`：反光强度 = roughness 倍率（0-2；对 roughnessMap 值整体缩放）；
 * - `bump`：凹凸强度 = normalScale / displacementScale 倍率（0-2）；
 * - `uv`：UV 大小 = 贴图平铺倍率（0.1-4，v0.2.1 增补 2）。
 */
export interface BallParamScales {
  roughness: number
  bump: number
  uv: number
}

/** 默认（不调参）= 全部 1 倍，与未加调参功能前的渲染结果完全一致 */
export const DEFAULT_PARAM_SCALES: BallParamScales = { roughness: 1, bump: 1, uv: 1 }

/** 滑块合法区间 [0, 2]；非法输入（NaN/Infinity）回落到 1（不调参），不抛错 */
export function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(2, Math.max(0, v))
}

/** UV 大小滑块合法区间 [0.1, 4]；非法输入（NaN/Infinity）回落到 1（不平铺放大），不抛错 */
export function clampUv(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(4, Math.max(0.1, v))
}

/** 2 位小数（hash 输入与落库值都用它，保证 DB 值与 hash 输入不漂移） */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * 规范化：**先 clamp 再 round2**（docs/12 §3.1，顺序不可颠倒）。
 *
 * 颠倒的后果：`NaN.toFixed(2)` → `"NaN"` → hash 里出现非 hex 字符 →
 * `parseThumbFileName`（shared/thumb.ts:56）解析失败 → 该资产的缓存管理全线失效。
 * clamp 的非法输入回落是 **1**（不是 0），这正是防 NaN 进 hash 的那道防线。
 */
export function normalizeParams(p?: BallParamScales): BallParamScales {
  const s = p ?? DEFAULT_PARAM_SCALES
  return {
    roughness: round2(clampScale(s.roughness)),
    bump: round2(clampScale(s.bump)),
    uv: round2(clampUv(s.uv))
  }
}

/**
 * hash 输入串：**固定字段顺序 roughness, bump, uv**（不是对象键序）。
 *
 * UI 两处都用 `{ ...s, roughness: x }` 构造对象，展开语法保留插入顺序但**不保证**
 * 跨进程一致 → hash 必须与键序无关（与 `slotRelPaths` 的 `sort()` 同理）。
 * 2 位小数是下限：滑块 step 0.1 时 2 位是超集，且能吸收 `Number(e.target.value)`
 * 的浮点噪声（`0.30000000000000004.toFixed(2) === '0.30'`）——否则同一个参数会
 * 算出两个名字，缓存无限膨胀。
 */
export function paramsKey(p: BallParamScales): string {
  const n = normalizeParams(p)
  return `${n.roughness.toFixed(2)},${n.bump.toFixed(2)},${n.uv.toFixed(2)}`
}

/** 是否等于默认（1,1,1）——方案 B 的判据：默认参数不贡献 hash（docs/12 §3.3） */
export function isDefaultParams(p: BallParamScales): boolean {
  const n = normalizeParams(p)
  return n.roughness === 1 && n.bump === 1 && n.uv === 1
}

/**
 * 读回某资产的参数：`undefined` 回落到默认（docs/12 §2.3，**不回填**）。
 *
 * 不回填的理由：回填会把「用户从未调参」与「用户调参调成了默认值」在 DB 里混为一谈，
 * 而方案 B 的缓存兼容恰好依赖这个区分（历史缓存文件名是「只 hash 槽位」）。
 * 读时再规范化一次：防历史脏值（`0.30000000000000004`）。
 */
export function resolveRenderParams(asset: Asset): BallParamScales {
  if (!asset.renderParams) return DEFAULT_PARAM_SCALES
  return normalizeParams(asset.renderParams)
}

/**
 * FNV-1a 32bit → 8 位小写十六进制。
 *
 * 与 `shared/thumb.ts` 的 `thumbSalt` 同算法同格式：这样球图缓存文件名
 * `<id>-<hash>.png` 能被既有缩略图管线（parseThumbFileName / deleteThumb /
 * pruneThumbs / thumbStats）原样识别，无需为材质球单开一套缓存管理。
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  const s = input ?? ''
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 槽位 rel 路径集合（去重 + 排序）。
 *
 * 与 `renderer/logic/materialBall.ts` 的 `slotRelPaths` 逐字同口径（`SLOT_ORDER`
 * 就是 `PBR_SLOT_ORDER`），放在 shared 是因为 shared 不能反向依赖 renderer。
 * 两处结果必须完全一致——否则主进程与渲染进程算出不同的 hash。
 */
export function ballSlotsRelPaths(slots: BallSlots): string[] {
  const set = new Set<string>()
  for (const key of PBR_SLOT_ORDER) {
    const rel = slots[key]
    if (typeof rel === 'string' && rel.length > 0) set.add(rel)
  }
  return [...set].sort()
}

/**
 * 球图缓存 hash：`slots 集合` +（非默认时）`参数串`。
 *
 * **方案 B（用户拍板，硬约束）**：`isDefaultParams(params)` 时 hash 输入不追加参数串
 * —— 现有磁盘缓存全部保留，只有真调过参的材质才重渲。这不是兼容 hack，而是
 * 「hash 输入的最短表示」：默认参数不改变渲染结果（`ballParams.test.ts` 已锁死
 * 「1 倍时三个 effective* 恒等于基准」这条回归）。
 *
 * golden 锁（docs/12 §3.3，实测值，写进测试防漂移）：
 * - `['vh1sbjl_2K_Albedo.jpg','vh1sbjl_2K_Normal.jpg']` → `7694126f`
 * - `['a.jpg','b.jpg']` → `8f3f48d0`
 * - `[]` → `811c9dc5`
 * - 第一组 + `1.00,1.00,1.00`（方案 A 形态）→ `c2dbee32`
 * - 第一组 + `1.50,1.00,0.50` → `340ed45f`
 */
/**
 * 渲染修订号（缓存失效闸门，docs/12 §3.3）。
 *
 * 规则：**只要球的观感变了就 +1**（本轮：环境光照全进程共享 + 贴图降采样 + 单图合成法线）。
 * 它只进 hash 输入的**前缀**，不参与任何计算、不进参数串 —— 用户调过的参数不会错位
 * （参数串仍然只在非默认时追加）。主进程与渲染进程都只用本文件的 `ballThumbName`
 * 算名字，因此两边天然算出同一个名字。
 */
export const RENDER_REV = 2

export function ballHash(slots: BallSlots, params: BallParamScales): string {
  const base = ballSlotsRelPaths(slots).join('\n')
  const key = isDefaultParams(params) ? '' : '\n' + paramsKey(params)
  return fnv1a('rev' + RENDER_REV + '\n' + base + key)
}

/**
 * 离屏渲染 PNG 的缓存文件名：`<id>-<ballHash>.png`。
 *
 * slots 由 rel 路径**集合**算出：换任何一张贴图（增删改路径）→ hash 变 →
 * 缓存自然失效；集合内容不变则名字不变（顺序无关）。参数同理（规范化后相等
 * → 同一个名字，防缓存膨胀）。第三参可选：不传 = 默认参数（既有 2 参调用合法）。
 *
 * 扩展名是 `.png`（透明背景）：卡片封面容器是 `bg-canvas`，透明像素透出卡片
 * 自身的画布色 → **深浅主题同一个缓存文件都正确**，无需按主题分缓存、也无需
 * 在切主题时重渲。hash 输入不受扩展名影响（`RENDER_REV` 与槽位/参数口径未变），
 * 旧 `.jpg` 球图仅因文件名不等而自然失效一次。
 */
export function ballThumbName(
  assetId: string,
  slots: BallSlots,
  params?: BallParamScales
): string {
  return `${assetId}-${ballHash(slots ?? {}, normalizeParams(params))}.png`
}
