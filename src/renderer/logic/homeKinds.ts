/**
 * 「首页封面页」文件夹卡的**候选顺序**。
 *
 * ## 结论（2026-11-09 用户回签，本批收口）
 *
 * **首页不出现独立的 D5A 文件夹卡。** `.d5a` 不是一个大类，而是**模型的一种格式**
 * （与 `.max` 同构）—— 用户原话：「你侧栏里面的分类没有 D5a，D5a 本身属于模型格式，
 * 但在模型的格式里面又找不到 D5a 的选择，然后你却在首页给我做了一个 d5a 的单独文件夹」。
 *
 * 所以 D5A 的入口统一收到一条路上：
 *   「模型」文件夹 → 中栏头「格式」筛选 → **D5A**
 * 这条入口与侧栏、与首页卡三者口径一致：
 *   · `kindsOfFilter('model')` = `{model, d5a}`（模型视图 = 模型的全部格式）；
 *   · 侧栏「所有模型」的计数与一级分类树走同一个入口；
 *   · 首页「模型」卡的计数也走 `kindsOfFilter`（`App.tsx` 的 `homeFolders`），
 *     所以卡上的数字 = 点进去看到的数量。
 *
 * ## 历史（别把这段当现状，它是"为什么现在没有补丁"的说明）
 *
 * v1.0.0 曾在这里用 `EXTRA_KINDS`（按落盘目录派生）把 `d5a` 补进候选集，于是首页多出
 * 一张 D5A 卡 —— 那是把 `.d5a` 当"独立大类"来救"用户找不到它"的权宜之计。
 * 用户当场指出三处口径不一致后，本批已经从**语义层**收口（d5a 属于模型格式），
 * 补丁随之删除：首页回到 `KIND_NAV_ORDER`（模型 / CAD图纸 / 材质 / HDRI / 其他），
 * **D5A 不再单独占卡**。不要再把 `EXTRA_KINDS` 加回来 —— 那会让同一个东西
 * 在首页有第四种说法。
 *
 * ⚠️ `KIND_NAV_ORDER` 本身仍然**不含** `d5a`（U-1 回签：导航序里不出现 D5A 项），
 * 这与"d5a 并进模型"完全一致，不需要重新回签：模型卡里的格式筛选就是它的入口。
 */
import { KIND_NAV_ORDER, type KindGroup } from '../../shared/classify'
import type { AssetKind } from '../../shared/types'

/**
 * 首页文件夹卡的候选顺序 = 侧栏导航序（`KIND_NAV_ORDER`）。
 *
 * 只有「有素材的大类」才真的出现（`App.tsx` 的 `homeFolders` 末尾有
 * `.filter(count > 0)`）。这里**不再**做任何"额外补 kind"的处理：
 * `texture` / `material` 已经被「材质」分组节点覆盖，`d5a` 并进「模型」的格式维度，
 * 其余 kind 都在 `KIND_NAV_ORDER` 里。
 *
 * 保留这个常量而不是让 `App.tsx` 直接用 `KIND_NAV_ORDER`：首页的候选集是**产品口径**
 * （可以调整顺序/取舍），而 `KIND_NAV_ORDER` 是跨端共用的"大类全集 + 落盘顺序"。
 * 分开之后，将来若要让首页换个排法（例如把 HDRI 提前），不必动那个共用常量。
 */
export const HOME_FOLDER_KEYS: ReadonlyArray<AssetKind | KindGroup> = [...KIND_NAV_ORDER]
