/**
 * 调参渲染纯逻辑单测（需求书 §3.3 + v0.2.1 增补 2，被测对象：
 * `src/renderer/logic/materialBall.ts` 的 `BallParamScales` / `clampScale` /
 * `clampUv` / `effectiveRoughness` / `effectiveBumpScale` / `effectiveUvRepeat`）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAM_SCALES,
  clampScale,
  clampUv,
  effectiveBumpScale,
  effectiveRoughness,
  effectiveUvRepeat
} from '../src/renderer/logic/materialBall'
import {
  RENDER_REV,
  ballHash,
  ballThumbName,
  clampAlpha,
  clampLight,
  clampMetal,
  fnv1a,
  isDefaultParams,
  normalizeParams,
  paramsKey,
  resolveRenderParams
} from '../src/shared/ballParams'
import { parseThumbFileName } from '../src/shared/thumb'
import type { Asset } from '../src/shared/types'

describe('logic/materialBall · 调参渲染（需求书 §3.3）', () => {
  it('DEFAULT_PARAM_SCALES = 1 倍 × 1 倍 × 1 倍（未调参 = 与旧渲染完全一致）', () => {
    // 0.6.9 追加三个参数：光强 1（默认照度）、金属 0（非金属=现状）、不透明 1
    expect(DEFAULT_PARAM_SCALES).toEqual({
      roughness: 1,
      bump: 1,
      uv: 1,
      light: 1,
      metal: 0,
      alpha: 1
    })
    // 1 倍时 roughness 恒等于基准、bump 恒等于基准、UV 恒等于形态基准（回归保障）
    expect(effectiveRoughness(false, 0.55, 1)).toBeCloseTo(0.55)
    expect(effectiveRoughness(true, 0.55, 1)).toBeCloseTo(1) // 有 map：1 倍 = map 原值
    expect(effectiveBumpScale(1, 1)).toBeCloseTo(1)
    expect(effectiveUvRepeat(1, 1)).toBe(1)
    expect(effectiveUvRepeat(2, 1)).toBe(2) // 平面形态基准 2，UV 1 倍时不变
  })

  it('clampScale：区间 [0,2]，越界夹紧，非法输入回落 1', () => {
    expect(clampScale(-0.5)).toBe(0)
    expect(clampScale(0)).toBe(0)
    expect(clampScale(1.37)).toBeCloseTo(1.37)
    expect(clampScale(2)).toBe(2)
    expect(clampScale(99)).toBe(2)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('反光强度：无 roughnessMap 时按 base × mult 计算并夹到 [0,1]', () => {
    // base 0.55：×2 = 1.1 → 夹到 1（全哑光）；×0 = 0（镜面）
    expect(effectiveRoughness(false, 0.55, 2)).toBeCloseTo(1)
    expect(effectiveRoughness(false, 0.55, 0)).toBeCloseTo(0)
    expect(effectiveRoughness(false, 0.55, 0.5)).toBeCloseTo(0.275)
  })

  it('反光强度：有 roughnessMap 时倍率即乘数，0-2 全程有效（>1 不夹）', () => {
    expect(effectiveRoughness(true, 0.55, 1.8)).toBeCloseTo(1.8)
    expect(effectiveRoughness(true, 0.55, 0)).toBe(0)
    expect(effectiveRoughness(true, 0.55, 2)).toBe(2)
  })

  it('凹凸强度：normalScale / displacementScale 线性缩放，0 = 拍平', () => {
    expect(effectiveBumpScale(1, 0)).toBe(0)
    expect(effectiveBumpScale(1, 1.5)).toBeCloseTo(1.5)
    expect(effectiveBumpScale(0.8, 2)).toBeCloseTo(1.6)
  })

  it('clampUv（v0.2.1 增补 2）：区间 [0.1,4]，越界夹紧，非法输入回落 1', () => {
    expect(clampUv(0.1)).toBe(0.1)
    expect(clampUv(0.05)).toBe(0.1) // 下界夹紧（不是 0）
    expect(clampUv(1)).toBe(1)
    expect(clampUv(2.35)).toBeCloseTo(2.35)
    expect(clampUv(4)).toBe(4)
    expect(clampUv(9)).toBe(4) // 上界夹紧
    expect(clampUv(-1)).toBe(0.1)
    expect(clampUv(Number.NaN)).toBe(1)
    expect(clampUv(Number.POSITIVE_INFINITY)).toBe(1)
    // clampScale 的 [0,2] 语义未被改动（另两个滑块仍用它）
    expect(clampScale(3)).toBe(2)
    expect(clampScale(-0.3)).toBe(0)
  })

  it('effectiveUvRepeat：形态基准 × UV 倍率，支持小数平铺', () => {
    expect(effectiveUvRepeat(1, 0.5)).toBeCloseTo(0.5) // 球/盒：贴图放大一倍显示
    expect(effectiveUvRepeat(2, 0.5)).toBeCloseTo(1) // 平面基准 2 × 0.5
    expect(effectiveUvRepeat(2, 3)).toBeCloseTo(6)
    expect(effectiveUvRepeat(1, 0.05)).toBeCloseTo(0.1) // 倍率被夹紧到 0.1
    expect(effectiveUvRepeat(1, Number.NaN)).toBe(1) // 非法输入回落 1
  })
})

// ── 2026-10 调参持久化（docs/12 §6.3）：新增用例，**既有断言一条未改** ─────
// 被测对象是 `src/shared/ballParams.ts`（hash 的唯一实现，主进程与渲染进程共用）。

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
/** golden 表的第一组槽位（与 tests/ballThumb.test.ts:35 同一份样本） */
const SLOTS = { albedo: 'vh1sbjl_2K_Albedo.jpg', normal: 'vh1sbjl_2K_Normal.jpg' }
/** hash 输入的第一组基串：rel 集合排序后以 \n 连接 */
const BASE = 'vh1sbjl_2K_Albedo.jpg\nvh1sbjl_2K_Normal.jpg'

describe('shared/ballParams · 规范化（docs/12 §3.1，先 clamp 再 round2）', () => {
  it('① 规范化幂等：normalizeParams(normalizeParams(p)) === normalizeParams(p)', () => {
    const p = { roughness: 1.374, bump: 0.04, uv: 4.6 }
    const once = normalizeParams(p)
    expect(normalizeParams(once)).toEqual(once)
    // 幂等是「DB 值与 hash 输入不漂移」的前提（§5.2）
    expect(paramsKey(once)).toBe(paramsKey(normalizeParams(once)))
  })

  it('② 浮点噪声吸收：0.30000000000000004 与 0.3 是同一个键', () => {
    expect(
      paramsKey({ roughness: 0.30000000000000004, bump: 1, uv: 1 })
    ).toBe(paramsKey({ roughness: 0.3, bump: 1, uv: 1 }))
    expect(paramsKey({ roughness: 0.3, bump: 1, uv: 1 })).toBe('0.30,1.00,1.00')
  })

  it('③ -0 归一：paramsKey({-0,1,1}) === "0.00,1.00,1.00"', () => {
    expect(paramsKey({ roughness: -0, bump: 1, uv: 1 })).toBe('0.00,1.00,1.00')
    // -0 若原样进 hash 会产出 '-0.00' —— 非 hex，parseThumbFileName 解析失败
    expect(normalizeParams({ roughness: -0, bump: 1, uv: 1 }).roughness).toBe(0)
  })

  it('④ 非法输入走 clamp 而非 NaN（先 clamp 再 round 的直接回归）', () => {
    expect(paramsKey({ roughness: Number.NaN, bump: Number.POSITIVE_INFINITY, uv: 5 })).toBe(
      '1.00,1.00,4.00'
    )
    // hash 输入必须全为 hex 可解析字符 —— 这条是整条缓存管线失效的防线
    const h = ballThumbName(ID, SLOTS, {
      roughness: Number.NaN,
      bump: Number.POSITIVE_INFINITY,
      uv: 5
    })
    expect(h).toMatch(new RegExp(`^${ID}-[0-9a-f]{8}\\.png$`))
    expect(h).not.toContain('NaN')
  })

  it('⑤ 键序无关（固定字段顺序 roughness, bump, uv，不依赖对象键序）', () => {
    expect(paramsKey({ bump: 1.5, uv: 2, roughness: 1 })).toBe(
      paramsKey({ roughness: 1, bump: 1.5, uv: 2 })
    )
    expect(paramsKey({ bump: 1.5, uv: 2, roughness: 1 })).toBe('1.00,1.50,2.00')
  })

  it('isDefaultParams：默认（含规范化后为默认）为 true，调过参为 false', () => {
    expect(isDefaultParams(DEFAULT_PARAM_SCALES)).toBe(true)
    expect(isDefaultParams({ roughness: 1.001, bump: 1, uv: 1 })).toBe(true) // round2 后仍是 1
    expect(isDefaultParams({ roughness: 1.01, bump: 1, uv: 1 })).toBe(false)
    expect(isDefaultParams({ roughness: Number.NaN, bump: 1, uv: 1 })).toBe(true) // clamp 回落 1
  })
})

describe('shared/ballParams · golden 锁（docs/12 §3.3 实测值，防 hash 输入格式漂移）', () => {
  it('第一组槽位 → d9d58630（方案 B + RENDER_REV=4）', () => {
    expect(ballHash(SLOTS, DEFAULT_PARAM_SCALES)).toBe('d9d58630')
    expect(ballThumbName(ID, SLOTS)).toBe(`${ID}-d9d58630.png`)
  })

  it("['a.jpg','b.jpg'] → c58e4b03", () => {
    expect(ballHash({ albedo: 'a.jpg', normal: 'b.jpg' }, DEFAULT_PARAM_SCALES)).toBe('c58e4b03')
  })

  it('空 slots → 60fd7dc8（RENDER_REV 前缀 + FNV-1a）', () => {
    expect(ballHash({}, DEFAULT_PARAM_SCALES)).toBe('60fd7dc8')
    expect(fnv1a('')).toBe('811c9dc5')
  })

  it("第一组 + '1.00,1.00,1.00' → c2dbee32（方案 A 形态，仅作为 golden 记录）", () => {
    // 方案 B 下默认参数不贡献 hash，所以 ballHash 仍是 d9d58630；
    // 这里锁的是「若无条件贡献会算出什么」——防止有人把方案 B 改成方案 A 而无人察觉。
    expect(fnv1a(BASE + '\n' + paramsKey(DEFAULT_PARAM_SCALES))).toBe('c2dbee32')
    expect(ballHash(SLOTS, DEFAULT_PARAM_SCALES)).not.toBe('c2dbee32')
  })

  it("第一组 + '1.50,1.00,0.50' → 2e1ac17a（参数变化 + RENDER_REV → 名字变）", () => {
    expect(fnv1a(BASE + '\n' + paramsKey({ roughness: 1.5, bump: 1, uv: 0.5 }))).toBe('340ed45f')
    expect(ballHash(SLOTS, { roughness: 1.5, bump: 1, uv: 0.5 })).toBe('2e1ac17a')
  })

  it('hash 输入必须带 \\n 分隔符（无分隔符会算出 4c25a542，与 golden 不符）', () => {
    // 这条把「参数串只能以 \n 追加」钉死：改分隔符 = 全库缓存名漂移
    expect(fnv1a(BASE + paramsKey(DEFAULT_PARAM_SCALES))).toBe('4c25a542')
  })
})

describe('shared/ballParams · 参数进 hash 后的缓存语义（docs/12 §6.3 ⑦⑧⑨⑩）', () => {
  it('⑦ 同 slots、不同 params → 不同缓存名', () => {
    const base = ballThumbName(ID, SLOTS)
    expect(ballThumbName(ID, SLOTS, { roughness: 1.5, bump: 1, uv: 0.5 })).not.toBe(base)
    expect(ballThumbName(ID, SLOTS, { roughness: 1, bump: 1.5, uv: 1 })).not.toBe(base)
  })

  it('⑧ 规范化后相等 → 同一个名字（防缓存膨胀的核心回归）', () => {
    expect(
      ballThumbName(ID, SLOTS, { roughness: 0.30000000000000004, bump: 1, uv: 1 })
    ).toBe(ballThumbName(ID, SLOTS, { roughness: 0.3, bump: 1, uv: 1 }))
    // 越界值规范化后也相等 → 同一个名字（滑块 step 抖动不会产出多份缓存）
    expect(
      ballThumbName(ID, SLOTS, { roughness: 9, bump: -1, uv: 0.05 })
    ).toBe(ballThumbName(ID, SLOTS, { roughness: 2, bump: 0, uv: 0.1 }))
  })

  it('⑨ 格式不变：仍是 <id>-<8位hex>.png，参数串不出现在文件名字面', () => {
    const name = ballThumbName(ID, SLOTS, { roughness: 1.5, bump: 1, uv: 0.5 })
    expect(name).toMatch(new RegExp(`^${ID}-[0-9a-f]{8}\\.png$`))
    const parsed = parseThumbFileName(name)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(ID)
    expect(parsed!.salt).toMatch(/^[0-9a-f]{8}$/)
    expect(name).not.toContain(',')
  })

  it('⑩ resolveRenderParams：undefined 回落默认；脏值走 clamp', () => {
    const asset = { id: ID, renderParams: undefined } as unknown as Asset
    expect(resolveRenderParams(asset)).toEqual(DEFAULT_PARAM_SCALES)
    // 历史 DB 只有三段（light/metal/alpha 缺失）→ 读回时补默认值
    expect(resolveRenderParams(asset as Asset)).toEqual({
      roughness: 1,
      bump: 1,
      uv: 1,
      light: 1,
      metal: 0,
      alpha: 1
    })
    expect(
      resolveRenderParams({ renderParams: { roughness: 9, bump: -1, uv: 0.05 } } as unknown as Asset)
    ).toEqual({ roughness: 2, bump: 0, uv: 0.1, light: 1, metal: 0, alpha: 1 })
    // 历史脏值（浮点噪声）读时再规范化一次 → 与 hash 输入一致
    expect(
      resolveRenderParams({ renderParams: { roughness: 0.30000000000000004, bump: 1, uv: 1 } } as unknown as Asset)
    ).toEqual({ roughness: 0.3, bump: 1, uv: 1, light: 1, metal: 0, alpha: 1 })
  })

  it('方案 B 硬约束：未调参（undefined）与显式默认值算出同一个名字（既有缓存全部保留）', () => {
    expect(ballThumbName(ID, SLOTS)).toBe(ballThumbName(ID, SLOTS, DEFAULT_PARAM_SCALES))
    expect(ballThumbName(ID, SLOTS)).toBe(
      ballThumbName(ID, SLOTS, resolveRenderParams({ id: ID } as unknown as Asset))
    )
  })
})

// ── 0.6.9：光线强度 / 金属度 / 透明度（用户反馈「光太强色差大」「金属体现不出质感」）──
// 三个参数的**默认值必须不改变既有成像**：光 1、金属 0（= 现状 `metalness:0`）、不透明 1。

describe('shared/ballParams · 0.6.9 新增三参数（light / metal / alpha）', () => {
  it('clampLight：区间 [0.2, 2]，越界夹紧，非法输入回落 1（不是 0——0 会全黑）', () => {
    expect(clampLight(0.1)).toBe(0.2) // 下界
    expect(clampLight(0.2)).toBe(0.2)
    expect(clampLight(1)).toBe(1)
    expect(clampLight(2.5)).toBe(2) // 上界
    expect(clampLight(-3)).toBe(0.2)
    expect(clampLight(Number.NaN)).toBe(1)
    expect(clampLight(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampLight(undefined)).toBe(1) // 历史参数没有这个字段
  })

  it('clampMetal：区间 [0, 1]（绝对值），非法输入回落 0（非金属 = 现状观感）', () => {
    expect(clampMetal(-0.4)).toBe(0)
    expect(clampMetal(0)).toBe(0)
    expect(clampMetal(0.35)).toBeCloseTo(0.35)
    expect(clampMetal(1)).toBe(1)
    expect(clampMetal(9)).toBe(1)
    expect(clampMetal(Number.NaN)).toBe(0)
    expect(clampMetal(undefined)).toBe(0)
  })

  it('clampAlpha：区间 [0.1, 1]，非法输入回落 1（不透明）', () => {
    expect(clampAlpha(0)).toBe(0.1) // 下界（0.1 而不是 0：0 等于看不见）
    expect(clampAlpha(0.1)).toBe(0.1)
    expect(clampAlpha(0.55)).toBeCloseTo(0.55)
    expect(clampAlpha(1)).toBe(1)
    expect(clampAlpha(3)).toBe(1)
    expect(clampAlpha(Number.NaN)).toBe(1)
    expect(clampAlpha(undefined)).toBe(1)
  })

  it('normalizeParams 六参数：先 clamp 再 round2（NaN 不许进 hash）', () => {
    expect(
      normalizeParams({ roughness: 1.374, bump: 0.04, uv: 4.6, light: 0.1, metal: 1.9, alpha: 0 })
    ).toEqual({ roughness: 1.37, bump: 0.04, uv: 4, light: 0.2, metal: 1, alpha: 0.1 })
    // 全非法 → 全默认；hash 输入里不会出现 "NaN"
    const bad = normalizeParams({
      roughness: Number.NaN,
      bump: Number.NaN,
      uv: Number.NaN,
      light: Number.NaN,
      metal: Number.NaN,
      alpha: Number.NaN
    })
    expect(bad).toEqual(DEFAULT_PARAM_SCALES)
    expect(paramsKey(bad)).toBe('1.00,1.00,1.00')
  })

  it('★paramsKey 兼容：默认参数下与旧的三段串**逐字符一致**（老缓存 / 老参数串仍算同一个键）', () => {
    // 引入新参数之前唯一合法的默认键就是这个字符串
    expect(paramsKey(DEFAULT_PARAM_SCALES)).toBe('1.00,1.00,1.00')
    expect(paramsKey({ roughness: 1, bump: 1, uv: 1 })).toBe('1.00,1.00,1.00')
    // 显式写全默认值也必须一样（历史 DB 读回来就是六字段形态）
    expect(paramsKey({ roughness: 1, bump: 1, uv: 1, light: 1, metal: 0, alpha: 1 })).toBe(
      '1.00,1.00,1.00'
    )
    // 等价于「默认参数不贡献 hash」：老资产的缓存文件名不变
    expect(ballThumbName(ID, SLOTS, { roughness: 1, bump: 1, uv: 1 })).toBe(
      ballThumbName(ID, SLOTS, DEFAULT_PARAM_SCALES)
    )
  })

  it('非默认任一参数 → key 变化（三个参数各一条）', () => {
    const base = paramsKey(DEFAULT_PARAM_SCALES)
    expect(paramsKey({ roughness: 1, bump: 1, uv: 1, light: 1.5 })).toBe('1.00,1.00,1.00,L1.50')
    expect(paramsKey({ roughness: 1, bump: 1, uv: 1, metal: 1 })).toBe('1.00,1.00,1.00,M1.00')
    expect(paramsKey({ roughness: 1, bump: 1, uv: 1, alpha: 0.5 })).toBe('1.00,1.00,1.00,A0.50')
    for (const p of [
      { roughness: 1, bump: 1, uv: 1, light: 1.5 },
      { roughness: 1, bump: 1, uv: 1, metal: 0.5 },
      { roughness: 1, bump: 1, uv: 1, alpha: 0.5 }
    ]) {
      expect(paramsKey(p)).not.toBe(base)
      // 参数变 → 缓存名变（否则新观感会写进旧名字的缓存文件）
      expect(ballThumbName(ID, SLOTS, p)).not.toBe(ballThumbName(ID, SLOTS, DEFAULT_PARAM_SCALES))
    }
  })

  it('isDefaultParams 把新参数算进去（默认 true；任一非默认 false）', () => {
    expect(isDefaultParams(DEFAULT_PARAM_SCALES)).toBe(true)
    expect(isDefaultParams({ roughness: 1, bump: 1, uv: 1, light: 1.001 })).toBe(true) // round2 后 1
    expect(isDefaultParams({ roughness: 1, bump: 1, uv: 1, light: 1.2 })).toBe(false)
    expect(isDefaultParams({ roughness: 1, bump: 1, uv: 1, metal: 0.05 })).toBe(false)
    expect(isDefaultParams({ roughness: 1, bump: 1, uv: 1, alpha: 0.8 })).toBe(false)
    expect(isDefaultParams({ roughness: 1, bump: 1, uv: 1, light: Number.NaN })).toBe(true)
  })

  it('★RENDER_REV 固定为 4 且无条件进 hash 前缀（取景 79%→94.4% 换了成像 → 旧图必须作废）', () => {
    // 这个数字只许往上加：改回 2 会让用户继续看到磁盘上那张 ACES + 长砖的旧图
    expect(RENDER_REV).toBe(4)
    expect(ballHash(SLOTS, DEFAULT_PARAM_SCALES)).toBe(fnv1a(`rev${RENDER_REV}\n` + BASE))
    // 参数没变、只有修订号变 → 名字必须不同（否则"作废旧缓存"这件事根本没发生）
    expect(fnv1a('rev2\n' + BASE)).not.toBe(fnv1a('rev3\n' + BASE))
  })
})
