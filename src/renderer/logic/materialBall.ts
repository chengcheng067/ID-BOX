/**
 * 材质球预览的**纯逻辑**（T09）——PBR 槽位识别 / 缓存文件名 / 贴图 URL。
 *
 * 不 import three / React / DOM / electron，可在 node 环境直接单测；
 * 组件（`components/MaterialBall.tsx`）与离屏渲染都复用这里的函数。
 *
 * 背景（用户拍板，docs/10 §1.4）：
 * - 网格用**离屏渲染存的 JPG** 当缩略图（走既有 thumbs 管线）；
 * - 详情面板保留**实时可拖拽的球**（绕开 Chromium WebGL 上下文 8-16 上限）。
 */
import type { AssetFile } from '../../shared/types'
import { vaultUrl } from '../../shared/format'
import { PBR_SLOT_ORDER, pbrTokenWords, type PbrSlot } from '../../shared/pbrSlots'
import { IMAGE_FILE_EXTS } from '../../shared/imageExts'
import { IMAGE_SIZE_HEAD_BYTES, imageSizeOf, type ImageSize } from '../../shared/imageSize'
import {
  TextureBitmapCache,
  bitmapCacheKey,
  type CacheableBitmap
} from './textureBitmapCache'

/** PBR 槽位键（与 MeshPhysicalMaterial 的贴图属性一一对应；与 shared 的 PbrSlot 同源） */
export type MaterialSlotKey = PbrSlot

/** 槽位 → 资产内贴图文件的 rel 路径；缺的槽位不出现在对象里 */
export interface MaterialSlots {
  albedo?: string
  normal?: string
  roughness?: string
  ao?: string
  displacement?: string
}

/** 与 MaterialSlots 同形的 URL 映射（键相同，值为 vault:// URL） */
export type MaterialSlotUrls = { [K in MaterialSlotKey]?: string }

/**
 * 固定遍历顺序（对象键序稳定，哈希才稳定）。
 * 与 shared 权威表的顺序同源，不再各写一份。
 */
export const SLOT_ORDER: readonly MaterialSlotKey[] = PBR_SLOT_ORDER

/**
 * 槽位关键词表 —— **不再自留一份**，取 `shared/pbrSlots.ts` 的唯一权威表
 * （2026-10 DEF-07 修复：此前 classify 与 materialBall 两套词表各自演化且都缺词，
 * 实测 AmbientCG 新版 `Color`、PolyHaven `diff`/`nor_gl`、裸简写全识别不全 → 灰球）。
 *
 * 这里用 **token 全等**口径（`pbrTokenWords`），因此包含 `col`/`nor`/`nrm`/`ao`
 * 这类只适合整 token 匹配的短词——`north` 不会被认成 normal，`kaolin` 不会被认成 ao。
 */
const SLOT_KEYWORDS: Record<MaterialSlotKey, readonly string[]> = {
  albedo: pbrTokenWords('albedo'),
  normal: pbrTokenWords('normal'),
  roughness: pbrTokenWords('roughness'),
  ao: pbrTokenWords('ao'),
  displacement: pbrTokenWords('displacement')
}

/** 参与槽位识别的图片扩展名（小写、不含点）。exr/hdr 只参与识别——three 的 TextureLoader 加载不了它们 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga', 'tif', 'tiff', 'exr', 'hdr'])

/**
 * 同一「前缀 + 槽位」出现多个文件时的取舍优先级（小 = 优先）。
 * 用户样本 B 同时有 `_Displacement.jpg` 与 `_Displacement.exr`——jpg 赢
 * （TextureLoader 能加载；exr 需要额外的 EXRLoader）。
 */
const EXT_RANK: Record<string, number> = {
  jpg: 0,
  jpeg: 0,
  png: 1,
  webp: 2,
  bmp: 3,
  tga: 3,
  tif: 4,
  tiff: 4,
  exr: 5,
  hdr: 5
}

/** 分辨率标记（`_2K` / `_4K` / `_1K`…）：识别时忽略，仅用于同槽位多文件时取高分辨率 */
const RESOLUTION_RE = /^(\d+)k$/i

/** 文件名切分：非字母数字一律当分隔符（`_ - . 空格` 等） */
const TOKEN_SPLIT_RE = /[^A-Za-z0-9]+/

/** 单个文件的槽位解析结果 */
interface SlotHit {
  slot: MaterialSlotKey
  /** 槽位关键词之前的 token 拼接（同前缀 = 同一组贴图） */
  prefix: string
  /** 文件名里的分辨率数值（2K → 2）；无标记为 0 */
  resK: number
  /** 扩展名优先级（同槽位多文件时小者胜） */
  rank: number
}

/** 分组内的条目（带上 rel 与输入序，用于择优） */
interface SlotEntry extends SlotHit {
  rel: string
  idx: number
}

/**
 * 从文件名（不含目录）解析槽位。
 *
 * 规则（用户拍板）：
 * 1. 按非字母数字切 token，全部转小写；
 * 2. 丢掉 `_2K/_4K` 类分辨率 token（记住数值用于同槽位择优）；
 * 3. **从右往左**找第一个槽位关键词命中（单 token 或相邻两 token 拼接），
 *    右侧优先可让 `Height_2K_Normal.jpg` 判成 normal 而不是 displacement；
 * 4. 命中点之前的 token joined by `_` 即「前缀」。
 *
 * 返回 null = 这个文件不是可识别的 PBR 贴图（预览图 / json / 模型本体…）。
 */
function parseSlotName(name: string, ext: string): SlotHit | null {
  if (!IMAGE_EXTS.has(ext)) return null
  const raw = name.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0)
  if (raw.length === 0) return null

  const tokens: string[] = []
  let resK = 0
  for (const t of raw) {
    const m = RESOLUTION_RE.exec(t)
    if (m) {
      resK = Math.max(resK, Number.parseInt(m[1]!, 10))
      continue
    }
    tokens.push(t.toLowerCase())
  }
  if (tokens.length === 0) return null

  for (let j = tokens.length - 1; j >= 0; j--) {
    const single = tokens[j]!
    const pair = j > 0 ? tokens[j - 1]! + tokens[j]! : ''
    for (const key of SLOT_ORDER) {
      const words = SLOT_KEYWORDS[key]
      // ⚠️ 相邻两 token 拼接（`base`+`color` → `basecolor`）必须先于单词检查：
      //    否则 `Oak_Base_Color` 会被单词 `color` 拦下、前缀变成 `oak_base`，
      //    与 `Oak_Rough` 的 `oak` 组分裂 → 组选优时 albedo/ao 整组丢词（2026-10 回归）。
      if (pair && words.includes(pair)) {
        return { slot: key, prefix: tokens.slice(0, j - 1).join('_'), resK, rank: EXT_RANK[ext] ?? 6 }
      }
      if (words.includes(single)) {
        return { slot: key, prefix: tokens.slice(0, j).join('_'), resK, rank: EXT_RANK[ext] ?? 6 }
      }
    }
  }
  return null
}

/** 同槽位多文件择优：分辨率高 → 扩展名优先级 → 输入序在前 */
function isBetterEntry(a: SlotEntry, b: SlotEntry): boolean {
  if (a.resK !== b.resK) return a.resK > b.resK
  if (a.rank !== b.rank) return a.rank < b.rank
  return a.idx < b.idx
}

/**
 * 从资产文件列表识别 PBR 槽位（用户样本 B 实证规则）。
 *
 * - 同「前缀 + 槽位」多个文件：分辨率高者胜 → 扩展名优先级高者胜 → 输入序在前者胜；
 * - 同目录出现多组贴图（多个前缀）时，取**槽位最全**的一组（并列取输入序在前者）；
 * - 一个槽位都没识别出 → 返回空对象 `{}`（调用方应回退普通缩略图策略）。
 */
export function materialSlots(files: AssetFile[]): MaterialSlots {
  // 按前缀分组（Map 保持插入序 = 各组首次出现的顺序）
  const groups = new Map<string, SlotEntry[]>()
  files.forEach((f, idx) => {
    const hit = parseSlotName(f.name, f.ext)
    if (!hit) return
    const entry: SlotEntry = { ...hit, rel: f.rel, idx }
    const list = groups.get(hit.prefix)
    if (list) list.push(entry)
    else groups.set(hit.prefix, [entry])
  })

  // 选组：distinct 槽位数多者胜；并列取先出现者（严格大于才替换）
  let best: SlotEntry[] | null = null
  let bestScore = 0
  for (const list of groups.values()) {
    const score = new Set(list.map((h) => h.slot)).size
    if (score > bestScore) {
      bestScore = score
      best = list
    }
  }
  if (best === null) return {}

  // 组内每个槽位择优
  const winners = new Map<MaterialSlotKey, SlotEntry>()
  for (const h of best) {
    const cur = winners.get(h.slot)
    if (cur === undefined || isBetterEntry(h, cur)) winners.set(h.slot, h)
  }

  const out: MaterialSlots = {}
  for (const key of SLOT_ORDER) {
    const w = winners.get(key)
    if (w) out[key] = w.rel
  }
  return out
}

/** slots 里的全部 rel 路径（去重 + 排序——哈希与「换贴图即换缓存」都基于它） */
export function slotRelPaths(slots: MaterialSlots): string[] {
  const set = new Set<string>()
  for (const key of SLOT_ORDER) {
    const rel = slots[key]
    if (typeof rel === 'string' && rel.length > 0) set.add(rel)
  }
  return [...set].sort()
}

/** 是否识别出了至少一个槽位（没有则不应渲染材质球） */
export function hasMaterialSlots(slots: MaterialSlots): boolean {
  return slotRelPaths(slots).length > 0
}

/**
 * 实际参与渲球的槽位（反馈 4，docs/15 §4：**单张 JPG/PNG 也要上材质球**）。
 *
 * 规则（纯函数，可单测）：
 * 1. 先走 `materialSlots` 的正常 PBR 识别；
 * 2. 认出了至少一个槽位 → **原样返回**，绝不被兜底覆盖（否则正常材质的 albedo
 *    会被"第一张图"顶掉，比如第一张恰好是 normal）；
 * 3. 一个槽位都没有 → 取 `files` 里第一张**图片**（按文件名顺序，不看目录），
 *    赋给 `albedo`（基础色）；这样单图导入的贴图也能渲出有颜色的球；
 * 4. 资产里没有任何图片（例如只有 `.skp` / `.json`）→ 返回 `{}`，仍不可渲球。
 *
 * 扩展名口径与入库白名单共用 `shared/imageExts.ts` 的 `IMAGE_FILE_EXTS`
 * （见该文件注释：两处各写一遍必然漂移）。
 */
export function effectiveMaterialSlots(files: AssetFile[]): MaterialSlots {
  const slots = materialSlots(files)
  // ① 已经认出 baseColor → 原样用
  if (slots.albedo) return slots
  // ② 认出了别的通道但**没有 baseColor**（典型：只有一张 `xxx_Normal.jpg`）——
  //    以前会直接返回 `{ normal }`，渲染出一个没有颜色贴图的白球。
  //    2026-10-21 走查：从「非数据通道图」里挑第一张补成 baseColor。
  // ③ 一张可当颜色的都没有 → 返回空对象（调用方据此不提供球预览）。
  const firstColor = files.find(
    (f) => IMAGE_FILE_EXTS.has(f.ext.toLowerCase()) && dataChannelOf(f) === null
  )
  if (!firstColor) return {}
  return { ...slots, albedo: firstColor.rel }
}

/**
 * 这张图本身是不是**数据通道图**（法线 / 粗糙度 / AO / 位移）。
 *
 * 用途：① 单图兜底时排除（不能当 albedo）；② 卡片上标出通道名，
 * 让「裸图封面」读起来是「这是法线贴图」而不是「球没渲出来」。
 * 返回 null = 不是数据通道图（普通颜色图 / 认不出的命名）。
 */
export function dataChannelOf(file: AssetFile): MaterialSlotKey | null {
  const hit = parseSlotName(file.name, file.ext.toLowerCase())
  if (!hit || hit.slot === 'albedo') return null
  return hit.slot
}

/** 通道的中文标签（卡片角标用） */
const SLOT_CN: Record<MaterialSlotKey, string> = {
  albedo: '颜色',
  normal: '法线',
  roughness: '粗糙度',
  ao: 'AO',
  displacement: '位移'
}

/**
 * 单图资产的「这张图是什么通道」标签；不是单图 / 不是数据通道 → null。
 * 只用于显示，不参与任何落盘或缓存键。
 */
export function dataChannelLabel(files: readonly AssetFile[]): string | null {
  if (files.length !== 1) return null
  const ch = dataChannelOf(files[0]!)
  return ch ? SLOT_CN[ch] : null
}

// ── 2026-10 用户反馈第 3 条：调参渲染接口（需求书 §3.3） ─────────────────────
//
// 2026-10 调参持久化（docs/12 §1.3）：类型与 clamp 的**权威定义已移到
// `shared/ballParams.ts`** —— hash 必须由主进程与渲染进程算出同一个值，所以
// 实现只能有一份，放在 shared（shared 不能反向依赖 renderer）。
// 这里保留**转发 re-export**，让既有调用方（tests/ballParams.test.ts、
// MaterialBall.tsx、CustomRenderDialog.tsx）的 import 路径一行都不用改。
// ⚠️ TS strict + isolatedModules 下 type 转发必须写 `export type { ... }`
//（不能写 `export { type X }`），否则直测会报 TS1484。
import {
  DEFAULT_PARAM_SCALES,
  ballHash,
  clampScale,
  clampUv,
  normalizeParams,
  type BallParamScales
} from '../../shared/ballParams'

// `DEFAULT_PARAM_SCALES` 既转发也被本文件的调参状态机读取（初始倍率）。
// 既有调用方（tests/ballParams.test.ts、MaterialBall.tsx、CustomRenderDialog.tsx）
// 的 import 路径一行都不用改。
export type { BallParamScales } from '../../shared/ballParams'
export { DEFAULT_PARAM_SCALES, clampScale, clampUv } from '../../shared/ballParams'

/**
 * 平铺倍率 = 形态基准 repeat × UV 倍率（v0.2.1 增补 2）。
 * three 支持小数 repeat + RepeatWrapping：`1 × 0.5` = 贴图放大一倍显示（半个平铺）。
 */
export function effectiveUvRepeat(baseRepeat: number, mult: number): number {
  return baseRepeat * clampUv(mult)
}

/**
 * 倍率 → MeshPhysicalMaterial.roughness 的**实际值**。
 *
 * three 的着色器里 `roughness` 是 roughnessMap 的**乘数**，所以：
 * - 有 roughnessMap：直接把倍率写进 roughness（0-2 全程有效）；
 * - 没有 roughnessMap：roughness 就是基础值本身，>1 无意义，按
 *   `base × mult` 计算后夹到 [0,1]（基准 0.55，×2 = 1 → 全哑光）。
 */
export function effectiveRoughness(hasRoughnessMap: boolean, baseRoughness: number, mult: number): number {
  const m = clampScale(mult)
  return hasRoughnessMap ? m : Math.min(1, baseRoughness * m)
}

/** 倍率 → normalScale.x/y 与 displacementScale 的实际值（线性缩放，0 = 拍平） */
export function effectiveBumpScale(baseScale: number, mult: number): number {
  return baseScale * clampScale(mult)
}

/**
 * FNV-1a 32bit → 8 位小写十六进制（委托 `shared/ballParams.ts` 的 `fnv1a`）。
 *
 * 与 `shared/thumb.ts` 的 thumbSalt 同算法同格式：这样球图缓存文件名
 * `<id>-<hash>.png` 能被既有缩略图管线（parseThumbFileName / deleteThumb /
 * pruneThumbs / thumbStats）原样识别，无需为材质球单开一套缓存管理。
 * 委托而非自行实现 —— 主进程与渲染进程必须算出同一个 hash（docs/12 §10）。
 */
function slotsHash(slots: MaterialSlots, params: BallParamScales): string {
  return ballHash(slots, params)
}

/**
 * 离屏渲染 **PNG**（透明背景）的缓存文件名：`<id>-<slotsHash>.png`。
 *
 * slotsHash 由 rel 路径**集合**算出：换任何一张贴图（增删改路径）→ hash 变 →
 * 缓存自然失效；集合内容不变则名字不变（顺序无关）。
 *
 * 扩展名必须与 `shared/ballParams.ts` 的 `ballThumbName` **逐字一致**（含 `.png`）：
 * store 的 `ballThumbIsFresh` 用本函数比对 `thumbPath`，而主进程落盘用的是 shared
 * 那份——任何一个停在 `.jpg`，`thumbPath === 期望名` 永远不成立 → 每次启动全库重渲。
 * 用 PNG 的理由见 shared 版注释（无 alpha 通道的 JPEG 会把纸色烤死，深色主题下变白块）。
 *
 * 2026-10 调参持久化（docs/12 §3.3，方案 B）：第三参 `params` 可选——
 * **默认参数（1,1,1）不贡献 hash**，所以未调参资产的既有缓存全部保留、不重渲；
 * 只有真调过参的材质才会算出不同的名字。参数串只进 hash，不进文件名字面。
 */
export function ballThumbName(
  assetId: string,
  slots: MaterialSlots,
  params?: BallParamScales
): string {
  return `${assetId}-${slotsHash(slots, normalizeParams(params))}.png`
}

/**
 * 槽位 rel 路径 → `vault://asset/<relFolder>/<rel>` URL（逐段 encodeURIComponent）。
 * 组件与离屏渲染都用它拼贴图地址；协议层的路由/越界检查见 shared/vault.ts。
 */
export function slotUrls(relFolder: string, slots: MaterialSlots): MaterialSlotUrls {
  const out: MaterialSlotUrls = {}
  const base = relFolder.replace(/\/+$/, '')
  for (const key of SLOT_ORDER) {
    const rel = slots[key]
    if (rel) out[key] = vaultUrl(`${base}/${rel}`)
  }
  return out
}

// ── 2026-10 修复：首帧质感 = 滑块值（P1 缺陷） ───────────────────────────────
//
// 缺陷复盘（实测，不要凭直觉改）：
// - `CustomRenderDialog` 的 `scales` 初值 = `resolveRenderParams(asset)`（滑块显示 1.7/1.6/2.5），
//   `params` 首帧**不是 undefined**，所以「懒挂载导致 params 缺失」的假设不成立；
// - `BallScene.baseRoughness` 是 `readonly 0.5` 常量，贴图流程从不写它，
//   所以「构造时基准未赋值」的假设也不成立；
// - 真正的原因在**组件时序**：`MaterialBall` 里 `useEffect(() => setParamScales(scales), [scales])`
//   声明在建场景 effect **之前**，挂载时它先跑（此刻 `ballRef.current === null`，空转），
//   建场景 effect 又没把 `params` 传给 `BallScene`（构造函数只能拿 DEFAULT）——
//   于是场景的 `lastScales` 永远停在 DEFAULT，`applyMaps` 落定后的那次重算用的也是 DEFAULT
//   → 首帧球是 1 倍（偏亮/偏反光），一拖滑块 params 变才被纠正。
//
// 因此本节的收敛点不是"猜时序"，而是把「材质就绪 → 按当前倍率重算」做成**状态机**：
// `ParamScaleState` 记 dirty，落定（markSettled）必然产出一份新值，调用方无从遗漏。

/** 材质参数的实际取值（与 three 解耦的纯数据，便于单测） */
export interface MaterialParamValues {
  /** MeshPhysicalMaterial.roughness（有 roughnessMap 时是乘数，无 map 时是 base × 倍率） */
  roughness: number
  /** normalScale.x / y 同值 */
  normalScale: number
  /** displacementScale */
  displacementScale: number
  /** 贴图平铺倍率 */
  uv: number
}

/**
 * 参数写入目标的最小接口。
 * `MeshPhysicalMaterial` 结构上满足它（`normalScale` 是 Vector2，带 `set(x, y)`），
 * 单测用一个普通对象即可，不需要 three / WebGL。
 */
export interface ParamMaterialTarget {
  roughness: number
  normalScale: { set(x: number, y: number): void }
  displacementScale: number
}

/** 把解析好的参数值写进材质（BallScene 与单测共用这一份写入口径） */
export function applyMaterialParams(target: ParamMaterialTarget, values: MaterialParamValues): void {
  target.roughness = values.roughness
  target.normalScale.set(values.normalScale, values.normalScale)
  target.displacementScale = values.displacementScale
}

/**
 * 参数基准。
 *
 * `baseRoughness` / `hasRoughnessMap` 决定 roughness 的口径（见 `effectiveRoughness`），
 * 两者都在**贴图批次落定**后才可信：贴图换一批，roughnessMap 的有无就变了。
 */
export interface ParamBasis {
  hasRoughnessMap: boolean
  baseRoughness: number
  baseNormalScale: number
  baseDisplacementScale: number
}

/** 基准补丁（`setBasis` / `markSettled` 的入参；只写关心的字段） */
export type ParamBasisPatch = Partial<ParamBasis>

/** 与 `BallScene` 一致的默认基准（0.04 位移见组件内注释：球是单位半径，4% 足够看出浮雕） */
export const DEFAULT_PARAM_BASIS: ParamBasis = {
  hasRoughnessMap: false,
  baseRoughness: 0.5,
  baseNormalScale: 1,
  baseDisplacementScale: 0.04
}

/**
 * 调参状态机（纯逻辑，可在 node 里单测）。
 *
 * 三条不变量：
 * 1. `setScales()` 任何时候都可以调；基准未落定时只产生**临时值**并置 `pending`；
 * 2. `setBasis()` 注入基准（例如贴图流程算出真实 baseRoughness）后**立即按最新倍率重算**，
 *    不需要调用方再补一次 `setScales`；
 * 3. `markSettled()` 返回的新值**一定是按当前倍率 + 最终基准算出来的**——
 *    这就是"材质就绪必然触发一次重算"的机械保证。
 */
export class ParamScaleState {
  private scales: BallParamScales = DEFAULT_PARAM_SCALES
  private basis: ParamBasis
  /** 基准是否落定（本批贴图已到位） */
  private settled = false
  /** 基准未落定期间收到过调参 → 落定时必须按最新 scales 再算一次 */
  private pending = false
  private values: MaterialParamValues

  constructor(basis: ParamBasisPatch = {}) {
    this.basis = { ...DEFAULT_PARAM_BASIS, ...basis }
    this.values = this.compute()
  }

  /** 当前倍率（调用方不要把默认值当作"场景里已经生效的值"） */
  get currentScales(): BallParamScales {
    return this.scales
  }

  /** 基准是否已落定 */
  get isSettled(): boolean {
    return this.settled
  }

  /** 基准未落定期间是否收到过调参（测试断言用） */
  get isPending(): boolean {
    return this.pending
  }

  /** 最近一次解析出的实际取值（只读快照） */
  get currentValues(): MaterialParamValues {
    return this.values
  }

  /** 记录一次调参并重算。返回是否需要在**落定后**再算一次（false = 已被基准"吃掉"） */
  setScales(scales: BallParamScales): MaterialParamValues {
    this.scales = scales
    if (!this.settled) this.pending = true
    this.values = this.compute()
    return this.values
  }

  /** 注入 / 校准基准：立即按最新倍率重算（dirty 语义不受影响） */
  setBasis(patch: ParamBasisPatch): MaterialParamValues {
    this.basis = { ...this.basis, ...patch }
    this.values = this.compute()
    return this.values
  }

  /** 换贴图：基准重新变为未落定（此后的调参只算临时值） */
  markPending(patch: ParamBasisPatch = {}): MaterialParamValues {
    this.basis = { ...this.basis, ...patch }
    this.settled = false
    this.pending = true
    this.values = this.compute()
    return this.values
  }

  /**
   * 贴图批次落定：写入最终基准 → 清 pending → 返回**按当前倍率重算**的新值。
   * 与上一条调参之间隔着任意长的异步窗口，这里都会补上那一次重算。
   */
  markSettled(patch: ParamBasisPatch = {}): MaterialParamValues {
    this.basis = { ...this.basis, ...patch }
    this.settled = true
    this.pending = false
    this.values = this.compute()
    return this.values
  }

  private compute(): MaterialParamValues {
    const b = clampScale(this.scales.bump)
    return {
      roughness: effectiveRoughness(
        this.basis.hasRoughnessMap,
        this.basis.baseRoughness,
        clampScale(this.scales.roughness)
      ),
      normalScale: effectiveBumpScale(this.basis.baseNormalScale, b),
      displacementScale: effectiveBumpScale(this.basis.baseDisplacementScale, b),
      uv: clampUv(this.scales.uv)
    }
  }
}

// ── 2026-10 性能修复 A：同一张贴图只解码一次 ──────────────────────────────────
//
// 缺陷复盘（实测）：`loadTexture` 先 `createImageBitmap(blob)` 全尺寸解一遍
// （8192² 原木 482ms）**只为拿宽高**，再带 resize 解一遍（434ms）→ 一次切换
// 1014ms 全在 CPU 解码。宽高完全可以只读**文件头**（`shared/imageSize.ts` 的
// `imageSizeOf`，纯字节解析、不解码），拿到尺寸后只做**一次**带 resize 的解码。
//
// 这里的实现刻意做成"可注入依赖"（fetch / createImageBitmap），
// 这样单测能用一个计数器断言"解码次数 = 1"而无需真的解码图片。

/** 解码计划：目标尺寸 + 是否发生了降采样 */
export interface DecodePlan {
  width: number
  height: number
  scaled: boolean
}

/**
 * 文件头尺寸 → 解码目标尺寸（**不改变最终贴图尺寸语义**：
 * 超过 `maxPx` 的按最长边等比缩到 `maxPx`，其余原样）。
 */
export function planTextureDecode(size: ImageSize, maxPx: number): DecodePlan {
  const w = Math.max(1, Math.round(size.w))
  const h = Math.max(1, Math.round(size.h))
  const limit = Number.isFinite(maxPx) && maxPx > 0 ? Math.floor(maxPx) : 0
  const longest = Math.max(w, h)
  if (limit <= 0 || longest <= limit) return { width: w, height: h, scaled: false }
  const k = limit / longest
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
    scaled: true
  }
}

/**
 * 解码结果的最小位图接口（`ImageBitmap` 结构上满足）。
 * `close()` 是必需的：缓存 `clear()` 时要能真正释放（见 textureBitmapCache 的销毁纪律）。
 */
export type DecodedBitmap = CacheableBitmap

/** `fetch` 结果的最小接口（`Response` 结构上满足） */
export interface TextureFetchResponse {
  ok: boolean
  status: number
  blob(): Promise<Blob>
}

/** `decodeTextureBitmap` 的可注入依赖（单测用假实现，运行时由组件喂真实实现） */
export interface TextureDecodeDeps {
  fetchImpl: (url: string) => Promise<TextureFetchResponse>
  createBitmap: (blob: Blob, opts: ImageBitmapOptions) => Promise<DecodedBitmap>
  /** 读多少字节用于解析文件头，默认 `IMAGE_SIZE_HEAD_BYTES` */
  headBytes?: number
  /**
   * 已解码位图缓存（性能修复 D）。不传 = 不缓存（单测默认行为，便于精确数解码次数）。
   *
   * 命中时 `decodes === 0`，调用方拿到的就是缓存里那张位图（**不要** close 它）。
   */
  cache?: TextureBitmapCache | null
}

/** 一次贴图解码的结果 */
export interface TextureDecodeResult {
  bitmap: DecodedBitmap
  /** 实际调用 `createImageBitmap` 的次数（回归断言：未命中必须是 1，命中是 0） */
  decodes: number
  /** 是否在解码阶段就完成了降采样（false 时调用方需自行判断是否再缩） */
  scaled: boolean
  /** 是否来自缓存（true = 本次没有解码） */
  cached: boolean
  /** 文件头解析出的原始尺寸；null = 该格式不支持头部解析（走兜底） */
  sourceSize: ImageSize | null
}

/**
 * 取一张贴图的位图：**最多解码一次**，且优先命中已解码位图缓存（D）。
 *
 * - 先读 64KB 文件头拿原始尺寸（`imageSizeOf`，实测 0.09–0.15ms）；
 * - 用**目标尺寸**（`planTextureDecode`）算缓存 key → 命中直接返回，**不解码**；
 * - 未命中 → 带 `resizeWidth/resizeHeight` 解一次 → 存进缓存；
 * - 解析不出尺寸（webp/bmp/tga…）→ 全尺寸解一次，由调用方用 canvas 再缩
 *   （canvas 缩放不解码；**不会**再调一次 `createImageBitmap`），**且不进缓存**；
 * - `fetch` 非 2xx → 返回 null（调用方退回 `TextureLoader`，绝不假装成功）。
 *
 * ⚠️ 命中路径仍然要 `fetch` + `blob.slice(0, 64KB)`：key 里带的"目标尺寸"必须从
 * 文件头算出来。这不是多余开销（0.1ms 级），换来的是"同一张图不同目标尺寸不串味"
 * 与"不额外维护 url → 尺寸 的第二份映射"。
 */
export async function decodeTextureBitmap(
  url: string,
  maxPx: number,
  deps: TextureDecodeDeps
): Promise<TextureDecodeResult | null> {
  const res = await deps.fetchImpl(url)
  if (!res.ok) return null
  const blob = await res.blob()
  const headBytes = deps.headBytes ?? IMAGE_SIZE_HEAD_BYTES
  const head = new Uint8Array(await blob.slice(0, headBytes).arrayBuffer())
  const sourceSize = imageSizeOf(head)
  const cache: TextureBitmapCache | null = deps.cache ?? null

  // imageOrientation:'flipY' + texture.flipY=false（与 <img> 路径的朝向一致）
  const opts: ImageBitmapOptions = { imageOrientation: 'flipY' }
  if (sourceSize) {
    const plan = planTextureDecode(sourceSize, maxPx)
    if (plan.scaled) {
      opts.resizeWidth = plan.width
      opts.resizeHeight = plan.height
      opts.resizeQuality = 'medium'
    }
    // ★ D：先查缓存（key 用**目标尺寸**，与解码结果同一口径）
    const key = bitmapCacheKey(url, plan.width, plan.height)
    if (cache) {
      const hit = cache.get(key)
      if (hit) {
        return { bitmap: hit, decodes: 0, scaled: plan.scaled, cached: true, sourceSize }
      }
    }
    const bitmap = await deps.createBitmap(blob, opts)
    if (cache) cache.set(key, bitmap)
    return { bitmap, decodes: 1, scaled: plan.scaled, cached: false, sourceSize }
  }
  // 尺寸未知：目标尺寸谈不上 → 不进缓存（缓存条目没有稳定的 key 可用）
  const bitmap = await deps.createBitmap(blob, opts)
  return { bitmap, decodes: 1, scaled: false, cached: false, sourceSize: null }
}

// ── 2026-10 性能修复 B：合成法线的采样尺寸与上下文选项 ───────────────────────

/**
 * 合成法线的采样边长（**256**，原 384）。
 *
 * 依据（不是"应该没事"）：
 * - 合成法线来自 albedo 的**亮度梯度**（Sobel），是低频信息：贴图上 1/256 周期的
 *   起伏才是它能表达的极限，384 与 256 的差别只在"已经低于可见阈值的细节"；
 * - 球在屏幕上最大 459px、且最终贴图被降到最大 1024：uv=2.5 时 256×2.5=640 texels
 *   覆盖整个球面 > 459 屏幕像素，仍然过采样（不会糊）；
 * - 384 → 256 像素数降到 44%，`getImageData` 的同步回读成本同比例下降。
 */
export const SYNTH_NORMAL_SIZE_PX = 256

/** 合成法线的画布尺寸（按原图宽高比等比，短边不小于 2） */
export function synthNormalSize(width: number, height: number): { w: number; h: number } {
  const w = Math.max(2, Math.min(SYNTH_NORMAL_SIZE_PX, Math.round(width)))
  const h = Math.max(2, Math.round((w * height) / Math.max(1, width)))
  return { w, h }
}

/**
 * 需要**同步回读**像素（`getImageData`）的 2D 上下文必须显式声明
 * `willReadFrequently`：否则 Chromium 把画布放在 GPU 上，回读要等一次
 * GPU→CPU 同步拷贝（实测 384² 上 30.7ms）。声明后走 CPU 后备存储，回读是内存拷贝。
 */
export const READBACK_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = {
  willReadFrequently: true
}

