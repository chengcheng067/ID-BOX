/**
 * 动效性能三档（设置·外观「动效性能」）单测。
 *
 * 三条硬约束：
 * ① `dprCap` / `anisotropy` 三档**严格单调递增**（smooth < balanced < ultra）——
 *    否则「极致」在低端机上可能比「均衡」还省，用户切档会觉得"没反应 / 反而更糊"；
 * ② `motionProfileOf` 对任何非法输入一律返回 `balanced` 的**同一个引用**
 *    （调用方要能用 `=== MOTION_PROFILES.balanced` 判断默认档）；
 * ③ 走真实读档链路（`SettingsSchema.safeParse` → `migrateSettings`，与 loadSettings 同一条路）：
 *    缺键 / 脏值只让 `motionQuality` 回落 'balanced'，**同文件里的 libraryDir、gridDensity
 *    绝不能丢**（zod enum 默认行为是整份 safeParse 失败，那会让用户"库消失"）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SettingsSchema, migrateSettings, normalizeSettings } from '../src/main/settings'
import { MOTION_PROFILES, MOTION_QUALITY_ORDER, motionProfileOf } from '../src/shared/motionQuality'
import {
  currentMotionProfile,
  setMotionQuality,
  subscribeMotionProfile
} from '../src/renderer/logic/motionProfile'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'

const LIB = 'E:\\X'

/** 走「读档链路」：schema 解析 → 迁移收口（与 loadSettings 完全同一条路） */
function readThroughSchema(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw)
  // 解析必须整体成功：脏值拖垮整份设置 = 用户库路径丢失（本项目踩过的坑）
  expect(parsed.success).toBe(true)
  return migrateSettings(parsed.success ? parsed.data : ({} as never))
}

describe('motionQuality：三档配置表', () => {
  it('三档齐全，且顺序常量覆盖全部档位', () => {
    expect(Object.keys(MOTION_PROFILES).sort()).toEqual(['balanced', 'smooth', 'ultra'])
    expect([...MOTION_QUALITY_ORDER].sort()).toEqual(['balanced', 'smooth', 'ultra'])
  })

  it('dprCap 严格递增：smooth < balanced < ultra', () => {
    expect(MOTION_PROFILES.smooth.dprCap).toBeLessThan(MOTION_PROFILES.balanced.dprCap)
    expect(MOTION_PROFILES.balanced.dprCap).toBeLessThan(MOTION_PROFILES.ultra.dprCap)
  })

  it('anisotropy 严格递增：smooth < balanced < ultra', () => {
    expect(MOTION_PROFILES.smooth.anisotropy).toBeLessThan(MOTION_PROFILES.balanced.anisotropy)
    expect(MOTION_PROFILES.balanced.anisotropy).toBeLessThan(MOTION_PROFILES.ultra.anisotropy)
  })

  it('预热只有「极致」激进（另外两档等 idle 调度）', () => {
    expect(MOTION_PROFILES.smooth.eagerPrewarm).toBe(false)
    expect(MOTION_PROFILES.balanced.eagerPrewarm).toBe(false)
    expect(MOTION_PROFILES.ultra.eagerPrewarm).toBe(true)
  })

  it('label / hint 都有内容，且「推荐」标记不进 label', () => {
    for (const q of MOTION_QUALITY_ORDER) {
      const p = MOTION_PROFILES[q]
      expect(p.id).toBe(q)
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.hint.length).toBeGreaterThan(0)
      expect(p.label).not.toContain('推荐')
    }
    expect(MOTION_PROFILES.smooth.label).toBe('流畅')
    expect(MOTION_PROFILES.balanced.label).toBe('均衡')
    expect(MOTION_PROFILES.ultra.label).toBe('极致')
  })
})

describe('motionQuality：motionProfileOf（非法输入一律回落均衡）', () => {
  it('合法值返回对应档位', () => {
    expect(motionProfileOf('smooth')).toBe(MOTION_PROFILES.smooth)
    expect(motionProfileOf('balanced')).toBe(MOTION_PROFILES.balanced)
    expect(motionProfileOf('ultra')).toBe(MOTION_PROFILES.ultra)
  })

  it('非法值（字符串 / 数字 / null / undefined / 对象）→ balanced 同一引用', () => {
    for (const dirty of ['bogus', 'high', '', 1, 0, null, undefined, {}, [] as unknown]) {
      expect(motionProfileOf(dirty)).toBe(MOTION_PROFILES.balanced)
    }
  })
})

describe('motionQuality：读档（schema + migrate）', () => {
  it('缺键 → balanced，且 libraryDir 保留', () => {
    const s = readThroughSchema({ libraryDir: LIB })
    expect(s.motionQuality).toBe('balanced')
    expect(s.libraryDir).toBe(LIB)
  })

  it("写档值 'ultra' / 'smooth' → 原样保留", () => {
    expect(readThroughSchema({ libraryDir: LIB, motionQuality: 'ultra' }).motionQuality).toBe('ultra')
    expect(readThroughSchema({ libraryDir: LIB, motionQuality: 'smooth' }).motionQuality).toBe('smooth')
  })

  it("脏值 'high' / 3 / null → balanced，且 libraryDir / gridDensity 不丢", () => {
    for (const dirty of ['high', 3, null, {}, true] as unknown[]) {
      const s = readThroughSchema({ libraryDir: LIB, motionQuality: dirty, gridDensity: 'small' })
      expect(s.motionQuality).toBe('balanced')
      // 关键断言：整份设置没有被回退成默认值
      expect(s.libraryDir).toBe(LIB)
      expect(s.gridDensity).toBe('small')
    }
  })
})

describe('motionQuality：写档归一化（normalizeSettings）', () => {
  it('缺键 / 脏值 → balanced，合法值保留', () => {
    expect(normalizeSettings({ libraryDir: LIB }).motionQuality).toBe('balanced')
    expect(
      normalizeSettings({ libraryDir: LIB, motionQuality: 'high' as never }).motionQuality
    ).toBe('balanced')
    expect(
      normalizeSettings({ libraryDir: LIB, motionQuality: 3 as never }).motionQuality
    ).toBe('balanced')
    expect(normalizeSettings({ libraryDir: LIB, motionQuality: 'ultra' }).motionQuality).toBe('ultra')
    expect(normalizeSettings({ libraryDir: LIB, motionQuality: 'smooth' }).motionQuality).toBe('smooth')
  })

  it('默认设置是 balanced（与文档口径一致）', () => {
    expect(DEFAULT_SETTINGS.motionQuality).toBe('balanced')
  })
})

/**
 * 2026-10 出包前修「滑块空转」：`logic/motionProfile` 从"只读单例"升级成"可订阅"。
 *
 * 这几条是**真单测**（不扫源码）：订阅语义错了，表现是"切档没反应"或"切一次重排两次"，
 * 都只能靠行为断言抓住。
 */
describe('motionQuality：进程内单例的订阅语义', () => {
  // setMotionQuality 是进程内全局状态，用例之间必须复位，否则污染同文件其它 describe
  afterEach(() => setMotionQuality('balanced'))

  it('切档后 currentMotionProfile 跟着变，监听器被通知一次', () => {
    setMotionQuality('balanced')
    let hits = 0
    const off = subscribeMotionProfile(() => {
      hits += 1
    })
    setMotionQuality('ultra')
    expect(currentMotionProfile().id).toBe('ultra')
    expect(hits).toBe(1)
    off()
  })

  it('同一档位重复 set 不触发（引用比较）；脏值归一化到 balanced 也算同档', () => {
    setMotionQuality('balanced')
    let hits = 0
    const off = subscribeMotionProfile(() => {
      hits += 1
    })
    setMotionQuality('balanced')
    setMotionQuality('bogus')
    setMotionQuality(undefined)
    expect(currentMotionProfile().id).toBe('balanced')
    expect(hits).toBe(0)
    off()
  })

  it('退订后不再通知；多个监听器各自独立', () => {
    setMotionQuality('balanced')
    let a = 0
    let b = 0
    const offA = subscribeMotionProfile(() => {
      a += 1
    })
    const offB = subscribeMotionProfile(() => {
      b += 1
    })
    setMotionQuality('smooth')
    expect([a, b]).toEqual([1, 1])
    offA()
    setMotionQuality('ultra')
    expect([a, b]).toEqual([1, 2])
    offB()
    setMotionQuality('balanced')
    expect([a, b]).toEqual([1, 2]) // 全部退订后无人被调用
  })

  it('getSnapshot 引用稳定：可直接喂 useSyncExternalStore', () => {
    setMotionQuality('ultra')
    // 同一档必须返回配置表里的同一个对象，否则 useSyncExternalStore 会自激重渲染
    expect(currentMotionProfile()).toBe(MOTION_PROFILES.ultra)
    expect(currentMotionProfile()).toBe(currentMotionProfile())
    setMotionQuality('balanced')
    expect(currentMotionProfile()).toBe(MOTION_PROFILES.balanced)
  })
})

/**
 * 源码守卫：档位必须真的接到渲染上（否则"切档没反应"会再次静默回归）。
 * node 环境跑不了 WebGL，只能钉接线点存在 + 旧的硬编码确实消失。
 */
describe('motionQuality：档位接线（源码守卫）', () => {
  const BALL = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/components/MaterialBall.tsx'),
    'utf-8'
  )
  const GRID = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/components/AssetGrid.tsx'),
    'utf-8'
  )

  it('DPR 上限来自 dprCap（不是字面量 2）', () => {
    expect(BALL).toContain('currentMotionProfile()')
    expect(BALL).toContain(
      'this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.dprCap))'
    )
    // 旧的硬编码必须消失
    expect(BALL).not.toContain('setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))')
  })

  it('贴图各向异性统一走 maxAnisotropy（旧的硬编码 4 已消失）', () => {
    expect(BALL).toContain('this.maxAnisotropy = Math.min(')
    expect(BALL).not.toContain('Math.min(4, this.renderer.capabilities.getMaxAnisotropy())')
    // 两处贴图（合成法线 / loadMap）都必须改走字段
    expect(BALL.split('tex.anisotropy = this.maxAnisotropy').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('热应用：存在 applyMotionProfile，且 setPixelRatio 后会重 setSize', () => {
    expect(BALL).toContain('applyMotionProfile(profile: MotionProfile): void')
    expect(BALL).toContain('ballRef.current?.applyMotionProfile(profile)')
    expect(BALL).toContain('useSyncExternalStore(')
    // three 的坑：只 setPixelRatio 不重排 drawingBuffer，必须再 resize 一次
    expect(BALL).toContain('if (this.lastSize) this.resize(this.lastSize.w, this.lastSize.h)')
    expect(BALL).toContain('this.lastSize = { w: width, h: height }')
    // 切档后要重传贴图，否则 anisotropy 变化进不了 GPU
    expect(BALL).toContain('t.needsUpdate = true')
  })

  it('AssetGrid 预热按 eagerPrewarm 分流（极致 0ms / 其它 60ms）', () => {
    expect(GRID).toContain('currentMotionProfile().eagerPrewarm ? 0 : 60')
  })
})
