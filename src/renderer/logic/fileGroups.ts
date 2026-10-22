/**
 * 详情面板**文件按 PBR 槽位分组**的纯逻辑（2026-10 用户反馈第 2 条，需求书 §3.2）。
 *
 * 用户原话：「点进去能看到哪个是法线贴图、哪一个是 AO 贴图」。
 *
 * 分组键与顺序（需求书 §3.2 拍板）：
 *   基础色 Albedo → 法线 Normal → 粗糙度 Roughness → 环境光遮蔽 AO →
 *   置换 Displacement → 元数据(json) → 预览(Preview) → 其他。
 *
 * 判定优先级（同一文件只进一组）：
 *   ① `.json` → 元数据（样本 B 的 `vh1sbjl_2K.json`）
 *   ② 文件名命中预览词（`shared/classify.ts` 的 `PREVIEW_NAME_RE`）→ 预览
 *      —— **必须先于槽位判定**：`Brick_Rough_…_Preview.png` 含 `rough`，
 *      否则官方渲染图会被误判成粗糙度贴图；
 *   ③ 文件名主干命中 PBR 槽位词 → 对应槽位组
 *   ④ 其余 → 其他（**不丢弃**，需求书明确）。
 *
 * ⚠️ TODO(词表统一)：槽位判定当前直接取 `shared/pbrSlots.ts` 的权威词表
 * （`matchPbrSlotToken` **token 全等**口径，与材质球侧 `logic/materialBall.ts`
 * 同一套词——`ao`/`col`/`nor` 这类短词只认完整 token，不做子串匹配）。
 * 另一位工程师正在 `shared/classify.ts` 合并/新增面向「文件分组展示」的槽位导出；
 * 落地后把 `slotOfStem` 换成那份导出即可，分组函数的对外签名不变。
 */
import type { AssetFile } from '../../shared/types'
import { PREVIEW_NAME_RE } from '../../shared/classify'
import { matchPbrSlotToken, PBR_SLOT_ORDER, type PbrSlot } from '../../shared/pbrSlots'

/** 文件组键：五个 PBR 槽位 + 元数据 + 预览 + 其他 */
export type FileGroupKey = PbrSlot | 'metadata' | 'preview' | 'other'

/** 组头展示文案（中文为主、附英文惯用名，需求书 §3.2 示例样式） */
export const FILE_GROUP_LABEL: Record<FileGroupKey, string> = {
  albedo: '基础色 Albedo',
  normal: '法线 Normal',
  roughness: '粗糙度 Roughness',
  ao: '环境光遮蔽 AO',
  displacement: '置换 Displacement',
  metadata: '元数据',
  preview: '预览',
  other: '其他'
}

/** 固定渲染顺序（空组不渲染） */
export const FILE_GROUP_ORDER: readonly FileGroupKey[] = [
  ...PBR_SLOT_ORDER,
  'metadata',
  'preview',
  'other'
]

/** 文件名切分：非字母数字一律当分隔符（与 `logic/materialBall.ts` 同口径） */
const TOKEN_SPLIT_RE = /[^A-Za-z0-9]+/

/**
 * 文件名主干 → PBR 槽位（token 全等，从右往左找第一个命中）。
 *
 * 与 `logic/materialBall.ts` 的 `parseSlotName` 同规则：
 * - 单 token 全等优先（`AO` / `albedo` / `normal`）；
 * - 相邻两 token 拼接兜底（`base_color` → `basecolor`、`nor_gl` → `norgl`）；
 * - 从右往左：`Height_2K_Normal` 判 normal 而非 displacement。
 *
 * 用 token 全等而非子串（`findPbrSlotInStem`）的原因：`ao` 是 tokenOnly 短词，
 * 子串口径下 `vh1sbjl_2K_AO` 判不出 AO 槽位（QA 实测复现），而 token 全等安全。
 */
function slotOfStem(stem: string): PbrSlot | null {
  const tokens = stem.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  for (let j = tokens.length - 1; j >= 0; j--) {
    const single = matchPbrSlotToken(tokens[j]!.toLowerCase())
    if (single) return single
    if (j > 0) {
      const pair = matchPbrSlotToken(tokens[j - 1]!.toLowerCase() + tokens[j]!.toLowerCase())
      if (pair) return pair
    }
  }
  return null
}

/** 单个文件判组（私有：导出会诱导调用方绕过分组函数自己拼组） */
function classifyFile(f: AssetFile): FileGroupKey {
  // ① 元数据：json 描述文件（样本 B 的 vh1sbjl_2K.json）
  if (f.ext.toLowerCase() === 'json') return 'metadata'
  // ② 预览词优先于槽位词（见文件头说明的 rough 误判问题）
  if (PREVIEW_NAME_RE.test(f.name)) return 'preview'
  // ③ PBR 槽位：主干 = 文件名去掉最后一个扩展名
  const dot = f.name.lastIndexOf('.')
  const stem = dot > 0 ? f.name.slice(0, dot) : f.name
  const slot = slotOfStem(stem)
  if (slot) return slot
  // ④ 其他：不丢弃
  return 'other'
}

export interface FileGroup {
  key: FileGroupKey
  label: string
  /** 组内文件（保持 asset.files 的原始顺序，前端展示稳定） */
  files: AssetFile[]
}

/**
 * 把资产文件列表按槽位/类型分组。
 *
 * - 空组**不出现在结果里**（组头不渲染，避免一排 0 计数）；
 * - 组内顺序与入参 `files` 一致；组间顺序固定为 `FILE_GROUP_ORDER`；
 * - 纯函数、零 IO，单测见 `tests/fileGroups.test.ts`。
 */
export function groupFilesBySlot(files: AssetFile[]): FileGroup[] {
  const buckets = new Map<FileGroupKey, AssetFile[]>()
  for (const f of files) {
    const key = classifyFile(f)
    const list = buckets.get(key)
    if (list) list.push(f)
    else buckets.set(key, [f])
  }
  const out: FileGroup[] = []
  for (const key of FILE_GROUP_ORDER) {
    const list = buckets.get(key)
    if (list && list.length > 0) {
      out.push({ key, label: FILE_GROUP_LABEL[key], files: list })
    }
  }
  return out
}
