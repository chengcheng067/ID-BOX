import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installRendererLogHooks } from './logic/rendererLog'

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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
