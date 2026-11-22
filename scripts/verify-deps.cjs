/**
 * 出包依赖完整性校验：把 asar 解到临时目录，逐个包检查它声明的 dependencies 能否解析。
 *
 * 起因（1.1.0 装机事故）：archiver-utils 是 archiver / zip-stream 的传递依赖，
 * dev 模式读 node_modules 一切正常，打包后 electron-builder 没把它收进 asar，
 * 点到「导出素材包」才炸 Cannot find module 'archiver-utils'。
 * 静态查标记（verify-asar.cjs）查不出这类问题 —— 包目录在不在不重要，
 * 重要的是「库内部 require 的那一刻能不能解析到」。
 *
 * 用法：node scripts/verify-deps.cjs [asar路径] [--keep]
 * 默认路径 release/win-unpacked/resources/app.asar
 * 只读源码，只在系统临时目录写解包副本（--keep 保留以便排查）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { builtinModules } = require('module')
const asar = require('@electron/asar')

const target = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'release/win-unpacked/resources/app.asar'
const keep = process.argv.includes('--keep')
const abs = path.resolve(target)

if (!fs.existsSync(abs)) {
  console.log('!! 找不到 asar:', abs)
  process.exit(2)
}

const B = new Set(builtinModules)
const skipDep = (name) => B.has(name) || name.startsWith('node:') || name === 'electron'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idbox-asar-verify-'))
const root = path.join(tmp, 'app')
console.log('解包到', root)
asar.extractAll(abs, root)

// 收集所有包目录（含嵌套 node_modules）
const pkgDirs = []
const walk = (dir) => {
  let ents = []
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (fs.existsSync(path.join(dir, 'package.json'))) pkgDirs.push(dir)
  for (const e of ents) if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(dir, e.name))
  const nm = path.join(dir, 'node_modules')
  if (fs.existsSync(nm)) {
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      if (e.name.startsWith('@')) {
        const scope = path.join(nm, e.name)
        for (const s of fs.readdirSync(scope, { withFileTypes: true })) {
          if (s.isDirectory()) walk(path.join(scope, s.name))
        }
      } else walk(path.join(nm, e.name))
    }
  }
}
walk(path.join(root, 'node_modules'))

if (!pkgDirs.length) {
  console.log('!! 包里没有 node_modules，asar 结构异常')
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(2)
}

const failures = []
let pkgCount = 0
let edgeCount = 0

// 只把「包根本找不到」算失败。ESM-only 包（如 unicorn-magic）在 require 下会抛
// ERR_PACKAGE_PATH_NOT_EXPORTED —— 包是存在的，只是不走 require 入口，属误报。
const resolves = (dep, fromDir) => {
  try {
    require.resolve(dep, { paths: [fromDir] })
    return true
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return false
    return true
  }
}

for (const dir of pkgDirs) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  pkgCount += 1
  const declared = Object.keys(pkg.dependencies || {})
  for (const dep of declared) {
    if (skipDep(dep)) continue
    edgeCount += 1
    if (!resolves(dep, dir)) {
      failures.push({
        from: pkg.name || path.relative(root, dir),
        dep,
        range: pkg.dependencies[dep],
      })
    }
  }
}

// 再补一刀：主进程产物里 createRequire(...)("x") / require("x") 的外部包必须能解析
const mainPath = path.join(root, 'out', 'main', 'index.cjs')
const mainFails = []
if (fs.existsSync(mainPath)) {
  const code = fs.readFileSync(mainPath, 'utf8')
  const ids = new Set()
  for (const m of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) ids.add(m[1])
  for (const m of code.matchAll(/createRequire\([^)]*\)\s*\(\s*["']([^"']+)["']\s*\)/g)) ids.add(m[1])
  for (const id of ids) {
    if (id.startsWith('.') || skipDep(id)) continue
    if (!resolves(id, path.dirname(mainPath))) mainFails.push(id)
  }
}

const rel = (p) => path.relative(root, p).split(path.sep).join('/')
console.log(`包数 = ${pkgCount}，依赖边 = ${edgeCount}`)
console.log('主进程外部包 =', mainFails.length ? `缺 ${mainFails.join(',')}` : '全部可解析')

for (const f of failures) {
  console.log(`[MISS] ${f.from} -> ${f.dep}@${f.range}`)
}

if (!keep) fs.rmSync(tmp, { recursive: true, force: true })
else console.log('保留解包副本:', root)

const bad = failures.length + mainFails.length
console.log(bad === 0 ? '\n依赖完整性通过' : `\n${bad} 处依赖缺失`)
process.exit(bad === 0 ? 0 : 1)
