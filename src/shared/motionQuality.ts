/**
 * 动效性能档位 → 渲染参数映射（**唯一**口径）。
 *
 * 设计约束（非常重要）：
 * - 本模块是**纯函数 + 纯数据**：不 import three、不碰 DOM / window / electron。
 *   这样既能被 main（落档归一化）、renderer（设置页 / 场景构建）共用，
 *   也能在 node 环境里直接单测，不需要 WebGL。
 * - 三档的数值必须**严格单调递增**（dprCap / anisotropy），否则「极致」在低端机上
 *   可能比「均衡」还省 —— 单测 `tests/motionQuality.test.ts` 钉住了这条。
 * - `hint` 是给用户看的一句话（设置页直接渲染），必须写清代价与收益，
 *   不要写「更高更好」这种没有信息量的文案。
 */
import type { MotionQuality } from './types'

/** 单档的渲染参数（渲染层构建 three 场景时读一次，运行期不订阅） */
export interface MotionProfile {
  /** 档位 id（与 `Settings.motionQuality` 同值域） */
  id: MotionQuality
  /** 展示名：流畅 / 均衡 / 极致（「推荐」标记由 UI 加，不要写进 label） */
  label: string
  /** 一句话说明：UI 直接渲染，必须含代价与收益 */
  hint: string
  /** 渲染 pixelRatio 上限（window.devicePixelRatio 会被夹到不超过它） */
  dprCap: number
  /** 贴图各向异性过滤上限（越大斜看材质越清晰，代价是采样开销） */
  anisotropy: number
  /** `true` = hover 预热不等 idle 调度，立刻排队（更跟手，代价是抢主线程） */
  eagerPrewarm: boolean
}

/**
 * 三档档位的展示顺序（设置页横排 / 文案顺序共用）。
 * 从「最省」到「最强」，用户从左到右读到的就是代价递增。
 */
export const MOTION_QUALITY_ORDER: readonly MotionQuality[] = ['smooth', 'balanced', 'ultra']

/** 三档配置表：**唯一**取值来源，别在别处再写一份阈值 */
export const MOTION_PROFILES: Record<MotionQuality, MotionProfile> = {
  smooth: {
    id: 'smooth',
    label: '流畅',
    hint: '省电，材质球略糊',
    dprCap: 1.5,
    anisotropy: 2,
    eagerPrewarm: false
  },
  balanced: {
    id: 'balanced',
    label: '均衡',
    hint: '默认，画质与占用平衡',
    dprCap: 2,
    anisotropy: 4,
    eagerPrewarm: false
  },
  ultra: {
    id: 'ultra',
    label: '极致',
    hint: '高分屏最清晰，贴图过滤更强、预热更积极',
    dprCap: 3,
    anisotropy: 8,
    eagerPrewarm: true
  }
}

/**
 * 任意输入 → 合法档位配置（**永不抛错**）。
 *
 * 非法的持久化值（`undefined` / `'high'` / `1` / `null` / `{}`）一律返回
 * `MOTION_PROFILES.balanced`，并且返回的是**同一个引用** —— 调用方可以安全地
 * 用 `=== MOTION_PROFILES.balanced` 判断「是否落在默认档」。
 */
export function motionProfileOf(value: unknown): MotionProfile {
  if (value === 'smooth') return MOTION_PROFILES.smooth
  if (value === 'ultra') return MOTION_PROFILES.ultra
  return MOTION_PROFILES.balanced
}
