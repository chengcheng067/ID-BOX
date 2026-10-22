/**
 * PBR 槽位关键词**唯一权威表**（2026-10 第 2 轮 QA 缺陷 DEF-07 修复）。
 *
 * 背景：此前有两套各自演化的词表——
 * - `shared/classify.ts` 的 `PBR_SLOT_PATTERNS`：子串正则，用于材质包大类判定；
 * - `renderer/logic/materialBall.ts` 的 `SLOT_KEYWORDS`：token 全等，用于材质球槽位识别。
 * 两套都缺词（`color / col / diff / basecol`、`NormalGL / NormalDX / nor / nrm`），
 * 且口径不一致 → QA 实测的四个样本里三个识别不全（渲出灰球 / 判不出材质包）。
 *
 * 现在合并成这一份，两侧都从这儿取词，杜绝再次分叉。**零 electron / 零 DOM**，可直接单测。
 */

/** PBR 槽位（与 MeshPhysicalMaterial 的贴图属性一一对应） */
export type PbrSlot = 'albedo' | 'normal' | 'roughness' | 'ao' | 'displacement'

/** 固定遍历顺序（对象键序稳定 → 哈希/择优结果才稳定） */
export const PBR_SLOT_ORDER: readonly PbrSlot[] = [
  'albedo',
  'normal',
  'roughness',
  'ao',
  'displacement'
]

export interface PbrSlotWord {
  /** 关键词（**小写**；可含 `_` 如 `base_color` / `nor_gl`） */
  word: string
  /**
   * true = **只参与 token 全等匹配**，不参与子串匹配。
   *
   * 短词做子串匹配会误伤：`col` 命中 `column`、`nor` 命中 `north`、`ao` 命中 `kaolin`。
   * 这些短词只在以**完整 token** 出现时才认（材质球侧就是 token 匹配，故仍能识别
   * PolyHaven 的 `nor_gl`、样本 B 的 `AO`）。
   */
  tokenOnly?: boolean
  /**
   * true = **打包图**（多槽位烘焙进一张图，如 PolyHaven 的 `arm` =
   * AO+Roughness+Metalness 合并图）。
   *
   * 语义：**分组/展示口径认它**（`matchPbrSlotToken` 会命中，fileGroups 落 AO 组），
   * **渲染择优口径排除**（`pbrTokenWords` 不含它）——把烘焙了粗糙度/金属度的
   * 合并图直接喂给 aoMap 会把材质球渲脏（2026-10 第 2 轮 QA 用例钉住此行为）。
   */
  packed?: boolean
}

/**
 * 槽位 → 关键词表。
 *
 * 词源：用户样本实证 + 行业惯例（docs/10 §2.2-③）+ QA 第 2 轮实测补漏。
 * 覆盖的命名风格：AmbientCG（`Albedo`/`Color`/`AmbientOcclusion`）、
 * Substance（`BaseColor`/`Base_Color`）、PolyHaven（`diff`/`nor_gl`/`rough`/`arm`）、
 * 裸简写（`color`/`normal`/`rough`）。
 */
export const PBR_SLOT_WORDS: Record<PbrSlot, readonly PbrSlotWord[]> = {
  albedo: [
    { word: 'albedo' },
    { word: 'basecolor' },
    { word: 'basecol' },
    { word: 'base_color' },
    { word: 'diffuse' },
    { word: 'diff' },
    { word: 'color' },
    { word: 'col', tokenOnly: true }
  ],
  normal: [
    { word: 'normal' },
    { word: 'normalgl' },
    { word: 'normaldx' },
    { word: 'normal_gl' },
    { word: 'normal_dx' },
    { word: 'norgl' },
    { word: 'nordx' },
    { word: 'nor_gl' },
    { word: 'nor_dx' },
    { word: 'nor', tokenOnly: true },
    { word: 'nrm', tokenOnly: true }
  ],
  roughness: [{ word: 'roughness' }, { word: 'rough' }],
  ao: [
    { word: 'ambientocclusion' },
    { word: 'ambient_occlusion' },
    { word: 'occlusion' },
    { word: 'ao', tokenOnly: true },
    // PolyHaven 的 arm = AO+Roughness+Metalness 打包图：分组认 AO 语义、渲染不进槽位
    { word: 'arm', tokenOnly: true, packed: true }
  ],
  displacement: [{ word: 'displacement' }, { word: 'disp' }, { word: 'height' }]
}

/**
 * token 全等匹配用的词表（**含 tokenOnly** 短词——整 token 相等是安全的；
 * **不含 packed** 打包图——渲染择优不能用烘焙合并图，见 `PbrSlotWord.packed`）。
 */
export function pbrTokenWords(slot: PbrSlot): readonly string[] {
  return PBR_SLOT_WORDS[slot].filter((w) => !w.packed).map((w) => w.word)
}

/** 子串匹配用的词表（**排除 tokenOnly**，防短词误伤） */
export function pbrSubstringWords(slot: PbrSlot): readonly string[] {
  return PBR_SLOT_WORDS[slot].filter((w) => !w.tokenOnly).map((w) => w.word)
}

/** 判定「材质包」必需的三个槽位（Albedo/BaseColor + Normal + Roughness） */
export const MATERIAL_PACK_REQUIRED_SLOTS: readonly PbrSlot[] = ['albedo', 'normal', 'roughness']

/**
 * token 全等匹配：给定**小写 token**，返回它属于哪个槽位（不命中返回 null）。
 * 材质球侧（`logic/materialBall.ts`）用它；`base_color` 这类含下划线的词在
 * token 场景匹配不到（下划线已被当分隔符），由相邻 token 拼接的 `basecolor` 兜住。
 *
 * **含 packed 打包图**（`arm` → ao）：分组/展示口径需要认出打包图的 AO 语义
 * （fileGroups 的 `slotOfStem` 走这里）；渲染侧不用本函数，走排除 packed 的
 * `pbrTokenWords`。
 */
export function matchPbrSlotToken(token: string): PbrSlot | null {
  if (!token) return null
  for (const slot of PBR_SLOT_ORDER) {
    for (const w of PBR_SLOT_WORDS[slot]) {
      if (w.word === token) return slot
    }
  }
  return null
}

/** 把文件名里的 `-` 与空白统一成 `_`（长度不变，索引可原样复用） */
function normalizeSeparators(stem: string): string {
  return stem.replace(/[\s\-]+/g, '_')
}

/**
 * 匹配规则（2026-10 修正版，修正两处回归，全部有测试钉住）：
 *
 * ① **槽位词必须是主干结尾段**：命中词之后只允许剩「空 / 分辨率段（2K、4K…）」。
 *    否则 `Brick_Rough_vh1sbjl_surface_Preview` 里的 `Rough`（产品名的一部分）
 *    会被误判成 roughness 槽位。
 * ② **被包含的短词让位给长词**：`base-color` 里 `color`（[5,10)）完全落在
 *    `base_color`（[0,10)）内部 → 取 `base_color`，前缀为空而不是 `base`。
 * ③ 互不重叠的多个候选取**最靠右**：`Height_2K_Normal` 判 normal 而不是
 *    displacement；同位置取更长词。
 *
 * @param stem 文件名主干（如 `wood_floor_nor_gl_4k`）
 */
export function findPbrSlotInStem(
  stem: string
): { slot: PbrSlot; prefix: string } | null {
  if (!stem) return null
  const normalized = normalizeSeparators(stem)
  const lower = normalized.toLowerCase()
  interface Candidate {
    start: number
    end: number
    slot: PbrSlot
    word: string
  }
  const candidates: Candidate[] = []

  for (const slot of PBR_SLOT_ORDER) {
    for (const word of pbrSubstringWords(slot)) {
      let from = 0
      for (;;) {
        const i = lower.indexOf(word, from)
        if (i < 0) break
        from = i + 1 // 允许重叠匹配，逐个起点扫
        const end = i + word.length
        const rest = normalized.slice(end)
        // 规则①：命中词后只允许空 / 分辨率段，否则这个词只是名字的一部分
        if (rest === '' || /^[_\-. ]*\d+(?:\.\d+)?[kK]?[_\-. ]*$/.test(rest)) {
          candidates.push({ start: i, end, slot, word })
        }
      }
    }
  }
  if (candidates.length === 0) return null

  // 规则②：丢弃被更长候选完全覆盖的短命中（`color` ⊂ `base_color`）
  const kept = candidates.filter(
    (c) =>
      !candidates.some(
        (o) =>
          o !== c &&
          o.word.length > c.word.length &&
          o.start <= c.start &&
          o.end >= c.end
      )
  )

  // 规则③：最靠右优先（同起点取更长词）
  let best = kept[0]!
  for (const c of kept) {
    if (c.start > best.start || (c.start === best.start && c.word.length > best.word.length)) {
      best = c
    }
  }
  // 前缀 = 命中点之前的部分，去掉尾部连接符（`_`/`-`/空格/点）
  const prefix = normalized.slice(0, best.start).replace(/[_\-. ]+$/, '')
  return { slot: best.slot, prefix }
}
