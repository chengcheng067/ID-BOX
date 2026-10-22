import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: 'src/main/index.ts',
        // 2026-10 装机反馈修复：强制 CJS 输出。
        // 背景：package.json 的 "type": "module" 会让 electron-vite 把 main 打成 ESM
        // （out/main/index.js + `import { app } from 'electron'`）。开发态该 import 会
        // 解析到 node_modules/electron 的 npm 垫片（CJS，导出的是可执行文件路径字符串），
        // Node 的 ESM→CJS 互译在 cjsPreparseModuleExports 阶段直接 TypeError → 启动即崩；
        // 打包态 asar 内没有 node_modules/electron，'electron' 走 Electron 内建解析才正常。
        // 打成 CJS 后 Rollup 把 import 编译成 require('electron')，dev / 打包两种形态
        // 都命中 Electron 主进程的模块拦截，返回真实 API（产出文件名随之变为 index.cjs，
        // 见 package.json 的 main 字段同步修改）。
        formats: ['cjs']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: 'src/preload/index.ts', formats: ['cjs'] }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer'), '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(__dirname, 'index.html') } }
    }
  }
})
