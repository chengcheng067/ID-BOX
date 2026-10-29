/**
 * 「**物理删除**」用的杂质判定（2026-10-30 用户要求：进库后把推广件从磁盘删掉）。
 *
 * 与 `classify.ts#isJunkFileName` 刻意是**两套**规则，不要合并、不要互相调用：
 *
 * - `isJunkFileName` 服务的是「**不进** files 索引」——判错的代价只是某个文件不出现在
 *   列表里，用户随时能重扫找回来，所以它敢用「说明」「下载」「推广」这类**泛词**。
 * - 本文件服务的是 `fs.rm`——判错的代价是**素材从磁盘上永久消失**（回收站都没有）。
 *   实测 `设计说明.dwg` / `施工说明.dwg` / `图例说明.dwg` / `下载的模型.skp` 全部会命中
 *   那套宽松正则：中文图纸名里「说明」极常见（设计说明、施工说明、图例说明都是标准图纸
 *   专业名），模型名里「下载」也常见。拿那套规则去删文件就是删用户的素材。
 *
 * 所以这里只放两类**高置信**条件：
 * ① 扩展名本身不是素材（网页 / 纯文本 / 快捷方式）→ 无论叫什么都绝不可能是资产内容；
 * ② 文件名命中**强推广词**（站方推广件专属、真实素材命名里几乎不出现的词）→
 *    即使扩展名是 jpg/png 也删（用户截图里那张 92 KB 的扫码图正是这一类）。
 *
 * 纯函数、零 IO，单测见 `tests/junkCleanup.test.ts`。
 */

/** 非素材扩展名（小写、不含点）：网页 / 纯文本 / 快捷方式，绝不可能是资产内容。 */
const NON_ASSET_EXTS: ReadonlySet<string> = new Set(['html', 'htm', 'txt', 'url', 'lnk'])

/**
 * 强推广词（大小写不敏感）—— 站方推广件专属，真实素材命名里几乎不出现。
 *
 * ⚠️ 刻意**不含**以下泛词，逐个说清为什么（它们都在 `isJunkFileName` 里，但绝不能在这里）：
 * - `说明`：`设计说明.dwg` / `施工说明.dwg` / `图例说明.dwg` 是标准 CAD 图纸名；
 * - `下载`：`下载的模型.skp` 是用户自己存下来的正常模型；
 * - `推广`：`推广方案.pdf` / `推广展位.dwg` 可能是真方案图（广告设计类素材）；
 * - `必用`：单独出现时多在半句话里（`必用的十个节点.dwg`）。
 * 真正要拦的是**整句推广话术**，所以下面用「微信扫码」「扫码关注」「知末…」这类
 * 只有站方营销图才会写的**完整短语**，而不是其中某个词。
 */
export const STRONG_PROMO_NAME_RE =
  /微信扫码|扫码关注|扫码领取|二维码|qrcode|知末网说明|知末SU|知末CAD图纸/i

/** 取小写扩展名（不含点）；无扩展名 / 隐藏文件（`.foo`）返回空串 */
function extOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : ''
}

/**
 * 判定一个文件名是否属于「落盘后应**物理删除**」的杂质。
 *
 * 规则（顺序即优先级，任一命中即 true）：
 * 1. 空名 → false（防御：`readdir` 不会给空名，但调用方可能传 undefined 进来）；
 * 2. 扩展名 ∈ {`.html`, `.htm`, `.txt`, `.url`, `.lnk`} → true（名字正常也删，
 *    如 `readme.txt`：纯文本在素材包里没有任何资产意义）；
 * 3. 文件名命中 `STRONG_PROMO_NAME_RE` → true（无论什么扩展名）；
 * 4. 其余 → false（**默认保留**。删除是不可逆的，拿不准就不删）。
 *
 * ⚠️ `.json` **不在**非素材扩展名里：PBR 材质包（AmbientCG / Crystal）的元数据就是
 * `.json`，`importer.ts` 会读它填 `materialMeta`（材质名 + 标签）。删了等于丢元数据。
 *
 * 反例（必须 false，`tests/junkCleanup.test.ts` 逐条钉死）：
 * `设计说明.dwg` / `施工说明.dwg` / `图例说明.dwg` / `下载的模型.skp` / `推广方案.pdf`
 * —— 扩展名是素材、且不含强推广词 → 保留。
 */
export function shouldDeleteJunkFile(name: string | undefined | null): boolean {
  if (!name || typeof name !== 'string') return false
  if (NON_ASSET_EXTS.has(extOf(name))) return true
  return STRONG_PROMO_NAME_RE.test(name)
}
