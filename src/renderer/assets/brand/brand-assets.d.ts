/**
 * 静态图片资源的模块声明。
 *
 * 为什么放在 assets/brand 里而不是 `src/renderer/env.d.ts`：env.d.ts 是「运行时 API」
 * （window.modvault）的全局声明，本次改动不碰它；而项目根 tsconfig.web.json 没有引
 * `vite/client` 的全局类型，所以 `import x from './mark.png'` 会报 TS2307。
 * 就近在资源目录声明一份，作用域靠 tsconfig.web.json 的 include（覆盖 src/renderer 全目录）。
 *
 * Vite 对这类 import 的处理：构建时把文件发到 `assets/` 并替换成带哈希的 URL 字符串，
 * 因此组件里拿到的是 string，直接给 `<img src>` 用（**不**内联 base64，避免撑大 bundle）。
 */
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.jpeg' {
  const src: string
  export default src
}

declare module '*.webp' {
  const src: string
  export default src
}
