/**
 * 「资产该落到哪个分类」的唯一判定实现（v1.0.13）。
 *
 * 为什么抽到 `shared/`：这套判定有**两个调用方、两种运行环境**——
 * - 主进程 `main/importer.ts`：导入那一刻预分类；
 * - 渲染层 `renderer/store.ts` 的「重跑自动分类」：把历史遗留的
 *   `未分类/未分类` 资产按**当前**词表重新判一次（分类只在导入时跑一次，
 *   词表/匹配规则升级后旧资产不会自己变好）。
 * 两份实现必然漂移（改一处忘另一处），故只留这一份。**纯函数、零 IO、零 electron 依赖**。
 *
 * 判定顺序（与 v1.0.10 / v1.0.12 的既定语义完全一致）：
 * 0. 【v1.0.14】`kind==='material'` 时先跑**材质频道专属二级表**（`MATERIAL_LEVEL2_MAP`，
 *    20 键 / 106 项，docs/18）——命中即返回 `matchedLevel:'material-l2'`；
 *    未命中才继续下面的通用流程（`texture` 不走这一步，理由见 `MATERIAL_L2_SCOPE_KINDS`）；
 *    【v0.8.5】`kind==='cad'` 时同理整轮换成 **CAD 词表**（`CAD_LEVEL2_MAP` + `CAD_LEVEL3_ALIAS`，
 *    docs/34 §二/§三）——二级/三级/一级键三层都被作用域隔离，
 *    `texture`/`model` 的匹配结果与改动前**逐字节一致**（见 `level2ScopeOf`）；
 *    【HDR】`kind==='hdri'` 时**只换一级册**（`HDRI_LEVEL1_LIST` 5 项），二级/三级两轮整个跳过
 *    ——站方 HDR 频道无二级级联，跑通用 40 项二级只会错分；
 * 1. `autoClassify()` 全量匹配（二级优先）；一级属于该 kind 的**容器**词表 → 采用；
 * 2. 否则**一级回退**：`autoClassify(name, undefined, { level1Only: true })` 再问一次
 *    "至少一级对不对"；一级过闸 → `{ 一级, 未分类 }`；
 * 3. 都不过 → 双哨兵 `未分类/未分类`。
 *
 * 原则：**宁可不分二级，也要保住正确的一级**。
 * 例：贴图名为「北欧挂画」时，全量匹配会命中 `软装陈设/挂画`（二级强度压过一级
 * `挂画`），而 `软装陈设` 是模型频道的一级、不在材质容器词表里 → 整包丢弃；
 * 回退后拿到一级 `挂画`（属于材质容器）→ 落 `材质/挂画/未分类`。
 * 若回退也失败（如 `屏风贴图` 的一级 `硬装构件` 真跨频道）→ 仍落双未分类。
 */

import { autoClassify } from './autoClassify'
import { isLevel1AllowedForKind, UNCLASSIFIED } from './taxonomy'

/** 一次分类判定的结果（只含落盘需要的两个字段） */
export interface ClassifyOutcome {
  category1: string
  category2: string
}

/**
 * 哪些 `kind` 走**材质频道专属二级表**（`MATERIAL_LEVEL2_MAP`，v1.0.14）。
 *
 * ⚠️ **只有 `'material'`，这是终态裁定（2026-10-20 主理人复核后确认），不是待办。**
 *
 * 【正面理由】`kind` 本来就是**频道身份**：`texture` = 贴图频道、`material` = 材质预设
 * 频道。两个频道的二级清单**零一致**（docs/18 §4：木材零重合，石材/金属/涂料仅 1~2 项
 * 偶合），因此**各用各的频道词表**才对 —— 这与「9 个同名一级不能互相复用」是同一条原则
 * 的正面表述，不是"材质覆盖更广"的妥协。
 *
 * 【反例·不要再把 texture 加进来】实测把 `'texture'` 加进这个集合会掉精度（不是提升）：
 * - `大理石瓷砖`：贴图表有完整词条 → `瓷砖/大理石瓷砖`；先扫材质表 → `石材/瓷砖`
 * - `卫生间瓷砖`：同上 → 退化成 `石材/瓷砖`
 * - `鱼肚白大理石`：贴图表 `大理石/鱼肚白大理石` → 退化成 `石材/大理石`
 * 原因：材质的 `石材 > 瓷砖` / `石材 > 大理石` 是**跨材种的粗类**，会盖住贴图侧更具体的
 * 完整词条。实测红线：加 `'texture'` 会让 `tests/importerSingleImage.test.ts`（大理石瓷砖.jpg）
 * 与 `tests/importerJunk.test.ts`（闸门端到端 大理石瓷砖）两条**既有断言变红**。
 *
 * 需要给 texture 增补词表时，正确做法是**补 docs/07 的贴图词表**（走 06 §12.2 流程），
 * 而不是借材质表。
 */
const MATERIAL_L2_SCOPE_KINDS: ReadonlySet<string> = new Set(['material'])

/**
 * 某个 `kind` 的**二级词表作用域**（`undefined` = 走通用 `LEVEL2_MAP` 流程）。
 *
 * - `'material'` → `MATERIAL_LEVEL2_MAP`（材质频道专属表，v1.0.14）；
 * - `'cad'` → `CAD_LEVEL2_MAP` + `CAD_LEVEL3_ALIAS`（CAD 频道整套词表，v0.8.5 / docs/34）；
 * - `'hdri'` → **只换一级册**（`HDRI_LEVEL1_LIST` 5 项），二级/三级两轮整个跳过。
 *   站方 HDR 频道只有一级细分、没有第三级，让通用 40 项二级词条跑一遍只会把
 *   `木纹HDR` 这类名字错分进贴图频道（详见 `autoClassify` 的 `level2Scope` 注释）。
 *
 * ⚠️ 这三个作用域的触发条件都**只按 kind**，不看内容：`kind` 就是频道身份。
 * ⚠️ `texture` 刻意**不**走 material 表（理由见 `MATERIAL_L2_SCOPE_KINDS` 的反例注释）。
 */
const level2ScopeOf = (kind: string): 'material' | 'cad' | 'hdri' | undefined =>
  MATERIAL_L2_SCOPE_KINDS.has(kind)
    ? 'material'
    : kind === 'cad'
      ? 'cad'
      : kind === 'hdri'
        ? 'hdri'
        : undefined

/**
 * 判定一个资产应落的「一级/二级」。
 *
 * @param assetName 资产名（导入时已清洗；重跑分类时直接用 `asset.name`）
 * @param fileNames 资产内文件名（仅参与二级匹配，见 `autoClassify` 规则 5）；可省略
 * @param kind 资产大类（`AssetKind`；决定闸门用哪套一级词表，以及是否走频道专属二级表）
 * @returns `{ category1, category2 }`；判不出来时两个都是 `未分类`
 */
export function classifyAssetName(
  assetName: string,
  fileNames: string[] | undefined,
  kind: string
): ClassifyOutcome {
  const level2Scope = level2ScopeOf(kind)
  const opts = level2Scope === undefined ? undefined : ({ level2Scope } as const)
  const hasFiles = fileNames !== undefined && fileNames.length > 0

  // ── 【v0.8.5】CAD 频道：**资产名优先、包内文件名只兜底**（两趟，不合并池） ──────
  //
  // 为什么 CAD 必须两趟：包内文件名表达的是**图种**（`1F平面图.dwg` / `立面图.dwg`），
  // 资产名表达的是**空间/类型**（`火锅店` / `别墅`）。合并成一个池子后，图种词
  // （`平面图` 等，本身是站方真实二级）会与内容词抢，而它往往是**更长**或**同长但二级优先**的一方。
  // 实测（知末真标题 1091 条）：合并池里给每行配一个 `60 1F-2F立面图.dwg`，
  // 二级命中从 30.8% 掉到 **1.8%**；改成"名字命中就不看文件名"后，伤害 0 条、还能救回 6~17 条。
  //
  // ⚠️ 顺序很重要：**名字先跑，落空才让文件名参与**；名字命中即采用，不再看文件名。
  if (level2Scope === 'cad') {
    const nameOnly = autoClassify(assetName, undefined, opts)
    if (nameOnly !== null && isLevel1AllowedForKind(kind, nameOnly.category1)) {
      return { category1: nameOnly.category1, category2: nameOnly.category2 }
    }
    if (hasFiles) {
      const withFiles = autoClassify(assetName, [...fileNames!], opts)
      if (withFiles !== null && isLevel1AllowedForKind(kind, withFiles.category1)) {
        return { category1: withFiles.category1, category2: withFiles.category2 }
      }
    }
    // 名字与文件名都没命中（或都被闸门拒）→ 一级回退（另一次调用，见下）
  } else {
    const rawHit = autoClassify(
      assetName,
      fileNames === undefined ? undefined : [...fileNames],
      opts
    )
    if (rawHit !== null && isLevel1AllowedForKind(kind, rawHit.category1)) {
      return { category1: rawHit.category1, category2: rawHit.category2 }
    }
  }

  // 一级回退：一级只看资产名（`autoClassify` 规则 5），故不传 fileNames。
  // ⚠️ 作用域必须一起带下去：CAD / HDR 的一级不在 `LEVEL2_MAP` 里，不传 scope 时
  // `level1Only` 对它们恒返回 null，回退等于没有。
  const level1Hit = autoClassify(assetName, undefined, {
    level1Only: true,
    ...(level2Scope === undefined ? {} : { level2Scope })
  })
  if (level1Hit !== null && isLevel1AllowedForKind(kind, level1Hit.category1)) {
    return { category1: level1Hit.category1, category2: UNCLASSIFIED }
  }
  return { category1: UNCLASSIFIED, category2: UNCLASSIFIED }
}
