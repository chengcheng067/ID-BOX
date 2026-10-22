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
import type { Asset, BallRenderShape, BallSlots } from './types'
import { PBR_SLOT_ORDER } from './pbrSlots'

/**
 * 调参渲染的**用户可调参数**（需求书 §3.3 前两版 + v0.2.1 增补 2 + 0.6.9 增补 3）：
 * - `roughness`：反光强度 = roughness 倍率（0-2；对 roughnessMap 值整体缩放）；
 * - `bump`：凹凸强度 = normalScale / displacementScale 倍率（0-2）；
 * - `uv`：UV 大小 = 贴图平铺倍率（0.1-4，v0.2.1 增补 2）；
 * - `light`：光线强度 = `scene.environmentIntensity`（0.2-2，默认 1）；
 * - `metal`：金属度 = `material.metalness` **绝对值**（0-1，默认 0 = 现状非金属）；
 * - `alpha`：不透明度（0.1-1，默认 1 = 不透明）。
 *
 * 后三个字段**可选**：历史 DB 里只有前三个字段（`renderParams` 落库早于本轮），
 * 读回来时 `light/metal/alpha` 是 `undefined`，由 `normalizeParams` 补默认值。
 * 保留可选还让大量既有调用点（测试 / 弹窗 / store）不必逐个补字段。
 *
 * ⚠️ `metal` 是**绝对值**而不是倍率：本项目的 `PBR_SLOT_ORDER` 里没有 metalness
 * 槽位（`MaterialSlots` 只有 albedo/normal/roughness/ao/displacement），所以不存在
 * "metalnessMap × 倍率"这条口径。哪天补了 metalness 槽位，这里要改成"有贴图时当倍率"。
 */
export interface BallParamScales {
  roughness: number
  bump: number
  uv: number
  light?: number
  metal?: number
  alpha?: number
}

/** 规范化后的参数（六个字段全部就位）——UI / 状态机 / hash 都用这个形态 */
export type NormalizedBallParams = Required<BallParamScales>

/** 默认（不调参）= 倍率 1、光强 1、非金属、不透明，与未加调参功能前的渲染结果一致 */
export const DEFAULT_PARAM_SCALES: NormalizedBallParams = {
  roughness: 1,
  bump: 1,
  uv: 1,
  light: 1,
  metal: 0,
  alpha: 1
}

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

/**
 * 光线强度 [0.2, 2]；非法输入回落到 **1**（= 默认光照，不是 0——0 会让球全黑）。
 *
 * 非有限值回落 1 与其它 clamp 同一纪律：这是"NaN 不许进 hash"的那道防线。
 */
export function clampLight(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(2, Math.max(0.2, v))
}

/**
 * 金属度 [0, 1]；非法输入回落到 **0**（非金属 = 现有观感）。
 *
 * 默认值刻意是 0 而不是 1：本参数诞生前所有资产都是 `metalness: 0`，默认必须是
 * "与旧渲染一致"，否则旧缓存／旧观感全部漂移。
 */
export function clampMetal(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/** 不透明度 [0.1, 1]；非法输入回落到 **1**（不透明 = 现有观感） */
export function clampAlpha(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(1, Math.max(0.1, v))
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
 * clamp 的非法输入回落是默认值（roughness/bump/uv/light/alpha 回 1，metal 回 0），
 * 这正是防 NaN 进 hash 的那道防线。
 */
export function normalizeParams(p?: BallParamScales): NormalizedBallParams {
  const s = p ?? DEFAULT_PARAM_SCALES
  return {
    roughness: round2(clampScale(s.roughness)),
    bump: round2(clampScale(s.bump)),
    uv: round2(clampUv(s.uv)),
    light: round2(clampLight(s.light)),
    metal: round2(clampMetal(s.metal)),
    alpha: round2(clampAlpha(s.alpha))
  }
}

/**
 * hash 输入串：**固定字段顺序 roughness, bump, uv**（不是对象键序），
 * 后三个参数**只在非默认时**追加，且带 `L/M/A` 前缀。
 *
 * 两条硬约束：
 * 1. 默认参数时输出必须与引入新参数前**逐字符一致**（`'1.00,1.00,1.00'`）——
 *    历史参数串（DB 里存的、测试里 golden 的）不会因为多加了三个参数而变形；
 * 2. 前缀字母让"哪个参数变了"在日志里可读，也避免 `,1.50` 这种无主片段。
 *
 * 键序无关：UI 两处都用 `{ ...s, roughness: x }` 构造对象，展开语法保留插入顺序
 * 但**不保证**跨进程一致 → 这里按固定顺序拼，不读对象键序。
 * 2 位小数是下限：滑块 step 0.1 时 2 位是超集，且能吸收 `Number(e.target.value)`
 * 的浮点噪声（`0.30000000000000004.toFixed(2) === '0.30'`）——否则同一个参数会
 * 算出两个名字，缓存无限膨胀。
 *
 * `parseThumbFileName` 不受影响：参数串只进 hash，不进文件名字面。
 */
export function paramsKey(p: BallParamScales): string {
  const n = normalizeParams(p)
  const parts = [n.roughness.toFixed(2), n.bump.toFixed(2), n.uv.toFixed(2)]
  if (n.light !== 1) parts.push(`L${n.light.toFixed(2)}`)
  if (n.metal !== 0) parts.push(`M${n.metal.toFixed(2)}`)
  if (n.alpha !== 1) parts.push(`A${n.alpha.toFixed(2)}`)
  return parts.join(',')
}

/** 是否等于默认（1,1,1 + 光 1 + 非金属 + 不透明）——方案 B 的判据：默认参数不贡献 hash */
export function isDefaultParams(p: BallParamScales): boolean {
  const n = normalizeParams(p)
  return (
    n.roughness === 1 &&
    n.bump === 1 &&
    n.uv === 1 &&
    n.light === 1 &&
    n.metal === 0 &&
    n.alpha === 1
  )
}

/**
 * 读回某资产的参数：`undefined` 回落到默认（docs/12 §2.3，**不回填**）。
 *
 * 不回填的理由：回填会把「用户从未调参」与「用户调参调成了默认值」在 DB 里混为一谈，
 * 而方案 B 的缓存兼容恰好依赖这个区分（历史缓存文件名是「只 hash 槽位」）。
 * 读时再规范化一次：防历史脏值（`0.30000000000000004`）。
 */
export function resolveRenderParams(asset: Asset): NormalizedBallParams {
  if (!asset.renderParams) return DEFAULT_PARAM_SCALES
  return normalizeParams(asset.renderParams)
}

/**
 * 读回某资产的形态：缺省 / 脏值一律回落到 `'sphere'`（= 本次改动前的唯一形态）。
 *
 * 与 `resolveRenderParams` 同一纪律：**读时兜底、不回填**。不回填的理由是
 * 「存量记录没有这个字段」与「用户明确选了球面」在渲染上等价，写库只是噪音；
 * 也因此不需要 Dexie 迁移。
 *
 * 全仓（store 的四处口径、主进程落盘名、测试）都必须走这里，
 * 不许各自写 `asset.renderShape ?? 'sphere'`——历史上"四处口径不同源"就是缓存 bug 的根因。
 */
export function resolveRenderShape(asset: Asset): BallRenderShape {
  const s = asset.renderShape
  if (s === 'plane' || s === 'roundedBox' || s === 'sphere') return s
  return 'sphere'
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
 * 渲染修订号（缓存失效闸门，docs/12 §3.3）。
 *
 * ## 纪律（2026-10 缓存策略修订，**请严格遵守**）
 *
 * **只在"成像公式"变更时 +1**：色调映射、相机（fov/距离/朝向）、UV 补偿、
 * 几何（球的细分/半径/形变）、光照口径（环境光/HDR/强度基准）——这些会改变
 * **同一输入的像素输出**，旧缓存与新渲染不是一张图，必须让它失效。
 *
 * **功能开发一律不 +1**：加按钮、加字段、改布局、改筛选、改文案、加 IPC 通道、
 * 改 store 逻辑——这些都**不改变成像**，+1 只会让全库缓存白白作废。
 *
 * **每次 +1 之前必须确认**：`store.ts` 的惰性升级（`noteVisibleAssets` /
 * `ensureMissingBallThumbs` / 3s trickle）已生效。因为 +1 会让**全库**球图名字
 * 过期——没有惰性升级时，+1 就等于"下次启动全量重渲"（用户明确否掉的行为：
 * 素材多时启动压力极大）。
 *
 * ## 历史
 * - 2：环境光照全进程共享 + 贴图降采样 + 单图合成法线；
 * - 3：**ACES → Neutral 色调映射** + **球面 UV 等距补偿**（u 方向 repeat ×2）
 *   + 环境光强度参数化。这三件事都改变成像，但**参数可以完全没变**（默认参数
 *   资产照样变样）——不加这个修订号，用户会一直看到磁盘上那张旧渲染图。
 *   本轮的 +1 会让所有旧球图缓存一次性作废（`regenThumbSweep` 会清掉旧的），
 *   这是有意为之，不是副作用。
 * - 4：**取景口径对齐包内 PBR 预览**（球占画面 79% → 94.4%，`logic/ballCamera.ts`）。
 *   成像公式变了（相机距离），而且**参数与贴图都没变**，所以必须 +1 让旧图作废；
 *   否则卡片会一直显示那张"球小一圈、上方留黑边"的旧图。
 *   ⚠️ 与 rev 3 不同，本次不再全量重渲：`708caf3` 起是**惰性升级**（看到哪升哪），
 *   只有真正被浏览到的资产才会替换球图。
 *
 * 它只进 hash 输入的**前缀**，不参与任何计算、不进参数串 —— 用户调过的参数不会错位
 * （参数串仍然只在非默认时追加）。主进程与渲染进程都只用本文件的 `ballThumbName`
 * 算名字，因此两边天然算出同一个名字。
 */
export const RENDER_REV = 4

/**
 * 形态的 hash 输入片段：**球面与缺省一律空串**。
 *
 * 为什么不能让 `'sphere'` 也拼进去：那会给全库存量球图凭空改名（hash 输入多两个
 * 字符 → 全部落到新名字）→ 升级后首次启动全量重渲，正是本次改动要消灭的行为。
 * 非球面才拼，于是"存量资产（无该字段）+ 球面"共享同一批缓存，只有真正切过形态的
 * 资产才需要一张新图。`tests/ballLazyUpgrade.test.ts` 用 golden 值钉死这条。
 */
function shapeHashKey(shape?: BallRenderShape): string {
  return !shape || shape === 'sphere' ? '' : '/' + shape
}

/**
 * 球图缓存 hash：`slots 集合` +（非默认时）`参数串` +（非球面时）`形态`。
 *
 * **方案 B（用户拍板，硬约束）**：`isDefaultParams(params)` 时 hash 输入不追加参数串
 * —— 现有磁盘缓存全部保留，只有真调过参的材质才重渲。这不是兼容 hack，而是
 * 「hash 输入的最短表示」：默认参数不改变渲染结果（`ballParams.test.ts` 已锁死
 * 「1 倍时三个 effective* 恒等于基准」这条回归）。
 *
 * **形态同理（2026-10 缓存策略）**：`'sphere'` / 缺省不追加——存量球图的名字逐字符
 * 不变；只有 plane / roundedBox 才换名（同一材质换了形态，成像必然不同）。
 *
 * golden 锁（docs/12 §3.3，实测值，写进测试防漂移）：
 * - `['vh1sbjl_2K_Albedo.jpg','vh1sbjl_2K_Normal.jpg']` → `7694126f`
 * - `['a.jpg','b.jpg']` → `8f3f48d0`
 * - `[]` → `811c9dc5`
 * - 第一组 + `1.00,1.00,1.00`（方案 A 形态）→ `c2dbee32`
 * - 第一组 + `1.50,1.00,0.50` → `340ed45f`
 * - 第一组 + `'sphere'` → `7694126f`（**与不传形态完全一致**，见 shapeHashKey）
 * - 第一组 + `'plane'` → 另一串（由 `tests/ballLazyUpgrade.test.ts` 钉住）
 */
export function ballHash(
  slots: BallSlots,
  params: BallParamScales,
  shape?: BallRenderShape
): string {
  const base = ballSlotsRelPaths(slots).join('\n')
  const key = isDefaultParams(params) ? '' : '\n' + paramsKey(params)
  return fnv1a('rev' + RENDER_REV + '\n' + base + key + shapeHashKey(shape))
}

/**
 * 离屏渲染 PNG 的缓存文件名：`<id>-<ballHash>.png`。
 *
 * slots 由 rel 路径**集合**算出：换任何一张贴图（增删改路径）→ hash 变 →
 * 缓存自然失效；集合内容不变则名字不变（顺序无关）。参数同理（规范化后相等
 * → 同一个名字，防缓存膨胀）。第三参可选：不传 = 默认参数（既有 2 参调用合法）。
 * 第四参 `shape` 可选：不传 / `'sphere'` 与既有名字**逐字符一致**，非球面才换名。
 *
 * 扩展名是 `.png`（透明背景）：卡片封面容器是 `bg-canvas`，透明像素透出卡片
 * 自身的画布色 → **深浅主题同一个缓存文件都正确**，无需按主题分缓存、也无需
 * 在切主题时重渲。hash 输入不受扩展名影响（`RENDER_REV` 与槽位/参数口径未变），
 * 旧 `.jpg` 球图仅因文件名不等而自然失效一次。
 */
export function ballThumbName(
  assetId: string,
  slots: BallSlots,
  params?: BallParamScales,
  shape?: BallRenderShape
): string {
  return `${assetId}-${ballHash(slots ?? {}, normalizeParams(params), shape)}.png`
}
