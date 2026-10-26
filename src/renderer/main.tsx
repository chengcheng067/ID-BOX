import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installRendererLogHooks } from './logic/rendererLog'
import { installEscProbe } from './logic/escLayer'
import { startAutoCheck } from './logic/updateState'
import { startSizeBackfill } from './logic/sizeBackfill'

// 渲染侧错误转发（2026-10 闪退取证）：把 `window.onerror` / `unhandledrejection`
// 转给主进程落 `[renderer]` 日志 —— 渲染进程崩掉时控制台是看不到的，只有落盘才留得下。
// 限流（同一消息 10 秒一次、总量 20 条/10 秒）在 installRendererLogHooks 内部完成，
// 避免三方库循环报错把真正的崩溃现场冲掉。
installRendererLogHooks((payload) => {
  try {
    window.modvault?.reportLog(payload)
  } catch {
    /* preload 缺失 / 窗口已销毁：日志转发绝不能反过来影响渲染 */
  }
})

// Esc 层栈深度探针（0.7.8：用户点名要修的「按 Esc 没反应」取证开关）。
//
// 为什么挂在入口而不是某个组件里：它要观察的是**全局**按键行为，且必须是「最后一个
// 还活着的观察者」—— 挂在任何弹窗组件里都会随弹窗卸载而消失，正好错过要取证的时机。
// 探针挂在 `keydown` **冒泡阶段**、只读记账、不 stopPropagation，绝不参与「谁吃按键」；
// 只有真的出现「按了 Esc 但没人应答」时才落一条 **debug** 日志（`verboseLogging`
// 关闭时不写盘，所以默认零成本、零噪音），并靠限流器封顶 20 条 / 10 秒。
// 限流与 sink 都复用渲染层日志那套，不新造通道。
installEscProbe({
  sink: (payload) => {
    try {
      window.modvault?.reportLog(payload)
    } catch {
      /* preload 缺失 / 窗口已销毁：取证绝不能反过来影响渲染 */
    }
  }
})

// 启动时自动检查更新（用户需求：「每一次运行都自动检测 GitHub 上有没有推新版本」）。
//
// **显式放在渲染进程入口**，不要依赖某个组件的模块求值时机：设置弹窗哪天被改成
// `lazy()`，自动检查会静默失效且无人发现。这里与 App 的挂载解耦：
// `startAutoCheck` 内部是异步的（先读设置再决定发不发请求）、**幂等**，
// 失败完全静默、不阻塞首帧。
startAutoCheck()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 启动后**后台**补采缺失的贴图尺寸（2026-10「分辨率筛选在材质与 HDR 都失效」）。
//
// `w/h` 自 0.6.0 才在导入时采集，老库 950 条资产一条都没有 → 筛选看着像"坏了"。
// `startSizeBackfill` 是**同会话自续**的驱动：每轮补 60 个 / 3 秒，轮间停 4 秒，
// 直到 `remaining === 0`（或撞 25 轮会话上限），**不需要用户重启 16 次**；
// 只补 texture / material / hdri（能力表里分辨率有意义的大类），读的是文件头
// （64KB）不解码整图。这里延迟 1500ms 让首帧与首屏缩略图先跑，
// 内部会话级 single-flight + 失败静默，绝不把启动链路的异常抛出去。
//
// **显式放在渲染进程入口**（同上面 `startAutoCheck` 的理由）：不要挂在某个组件的
// 模块副作用上 —— 组件哪天被改成 `lazy()`，这里会静默失效且无人发现。
setTimeout(() => {
  void startSizeBackfill()
}, 1500)
