/**
 * 渲染层「当前动效档位」的**进程内单例**（可订阅）。
 *
 * 数据流（单向）：
 *   settings.json → App 的 effect（订阅 `settings.motionQuality`）
 *   → `setMotionQuality(q)` → 本模块 → ① 场景**构建时**读一次（`currentMotionProfile()`）
 *                                ② 已挂载的场景**热应用**（`subscribeMotionProfile` → `applyMotionProfile`）
 *
 * 为什么需要订阅（2026-10，出包前修「滑块空转」）：
 * 上一批把「换资产不再重建 renderer」落地后，一个 `BallScene` 从挂载活到卸载。
 * 如果只在构造时读一次档位，用户切档必须重启才生效 —— 等于设置项没接线。
 * 所以这里提供 `subscribeMotionProfile`，`MaterialBall` 用 `useSyncExternalStore`
 * 订阅它，切档时对现有 renderer 热改 DPR / 各向异性（不重建上下文、不重载贴图）。
 *
 * 快照稳定性：`currentMotionProfile()` 返回的永远是 `MOTION_PROFILES` 里的**同一个对象**
 * （`motionProfileOf` 的返回值即该表引用），因此可以安全用作
 * `useSyncExternalStore` 的 getSnapshot —— 不会因为每次返回新对象而无限重渲染。
 *
 * ⚠️ 只有 App 调 `setMotionQuality`；渲染层只读 + 订阅，不写。
 */
import { motionProfileOf, type MotionProfile } from '../../shared/motionQuality'

/** 当前档位配置（兜底 = 均衡，保证任何时候读到的都是合法对象） */
let current: MotionProfile = motionProfileOf('balanced')

/** 订阅者集合（用 Set 而不是数组：退订 O(1)，且重复注册不会重复触发） */
const listeners = new Set<() => void>()

/**
 * 订阅档位变化，返回**退订函数**（可直接作为 `useSyncExternalStore` 的 subscribe）。
 *
 * 契约：只在**档位真的变了**时被调用（同档重复 set 不触发），且回调在
 * `setMotionQuality` 的同步栈里执行 —— 订阅方必须是幂等、可重入的轻量操作
 * （改 renderer 参数，不要在这里 setState 引发级联重渲染）。
 */
export function subscribeMotionProfile(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 写入当前档位。任何脏值都由 `motionProfileOf` 归一化成均衡档，**永不抛错**
 * （设置读档损坏 / 手改 settings.json 都不能让渲染层崩）。
 *
 * 同档不通知：`motionProfileOf` 返回的是配置表里的稳定引用，所以直接比引用即可。
 * 这条很重要 —— App 的 effect 在首屏就会跑一次 `setMotionQuality('balanced')`，
 * 若每次都通知，所有球会在启动时白做一轮 DPR 重排。
 */
export function setMotionQuality(q: unknown): void {
  const next = motionProfileOf(q)
  if (next === current) return
  current = next
  listeners.forEach((f) => f())
}

/** 读当前档位配置（引用稳定：同一档位永远返回同一个 profile 对象） */
export function currentMotionProfile(): MotionProfile {
  return current
}
