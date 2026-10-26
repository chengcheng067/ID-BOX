/**
 * 出包校验：读 asar 内的版本号 + 关键功能标记 + 二维码资源字节数。
 * 用法：node scripts/verify-asar.cjs [asar路径]
 * 只读，不改任何文件。
 */
const path = require('path')
const asar = require('@electron/asar')

const target = process.argv[2] || 'release/win-unpacked/resources/app.asar'
const abs = path.resolve(target)
const list = asar.listPackage(abs)

const norm = (p) => p.split('\\').join('/').replace(/^\//, '')
const find = (re) => list.map(norm).filter((f) => re.test(f))

const read = (p) => asar.extractFile(abs, p.split('/').join(path.sep)).toString()

let failed = 0
const check = (label, hay, needle) => {
  const ok = hay.includes(needle)
  if (!ok) failed += 1
  console.log(`${ok ? '[OK]  ' : '[MISS]'} ${label}`)
}

const pkg = JSON.parse(read('package.json'))
console.log('asar version =', pkg.version)

const mainFiles = find(/^out\/main\/index\.cjs$/)
const preFiles = find(/^out\/preload\/index\.cjs$/)
const rFiles = find(/^out\/renderer\/assets\/index-.*\.js$/)
const cssFiles = find(/^out\/renderer\/assets\/index-.*\.css$/)

if (!mainFiles.length || !preFiles.length || !rFiles.length || !cssFiles.length) {
  console.log('!! 缺少主进程/预加载/渲染入口文件，asar 结构异常')
  console.log(list.map(norm).filter((f) => f.startsWith('out/')).join('\n'))
  process.exit(2)
}

const main = read(mainFiles[0])
const pre = read(preFiles[0])
const renderer = read(rFiles[0])
const css = read(cssFiles[0])
// 0.7.3 起有跨 chunk 的标记（相机/材质球/救援在独立 chunk 里），
// 只搜 index-*.js 会漏 → 拼一份全量渲染 chunk 供新增标记使用。
const rendererAll = find(/^out\/renderer\/assets\/.*\.js$/)
  .map((f) => read(f))
  .join('\n')

check('main: update:check ipc', main, 'update:check')
check('main: github releases/latest', main, 'releases/latest')
check('main: deleteOneThumb (精确删图)', main, 'deleteOneThumb')
check('main: thumb:list 只读列目录', main, 'thumb:list')
check('preload: checkUpdate bridge', pre, 'checkUpdate')
check('preload: listThumbs bridge', pre, 'listThumbs')
check('renderer: startAutoCheck', renderer, 'startAutoCheck')
check('renderer: ballThumbTarget (球图不复用通配删)', renderer, 'ballThumbTarget')
check('renderer: regenThumbSweep', renderer, 'regenThumbSweep')
check('renderer: autoCheckUpdate 设置项', renderer, 'autoCheckUpdate')
check('renderer: rescan-pre 覆盖前快照', rendererAll, 'rescan-pre-')
check('renderer: rescue- 救援快照', rendererAll, 'rescue-')
// 判据是正则字面量 `/\.cover\.(png|…)/`，产物里保留反斜杠，所以标记要带转义
check('renderer: 派生封面判据 (\\.cover\\.)', rendererAll, '\\.cover\\.')
check('renderer: 球图取景距离 2.935225', rendererAll, '2.935225')
check('css: --preview-tint token', css, '--preview-tint')
check('css: folder-stage-leave 260ms', css, 'folder-stage-leave')

// ── 0.7.6 ──
// 主进程侧用日志字面量当标记：crashGuard 的函数名可能被压缩，但日志串一定保留。
check('main: crash:recovery 崩溃自恢复', main, 'crash:recovery')
check('main: crash:give-up 循环崩溃熔断', main, 'crash:give-up')
// 灰度透明的两个标记分别是 GLSL 里的 uniform 名与参数属性名（都不是压缩目标）。
check('renderer: 灰度透明 uAlphaInvert uniform', rendererAll, 'uAlphaInvert')
check('renderer: 灰度透明参数 alphaFromMap', rendererAll, 'alphaFromMap')
// 函数名会被压缩，用字符串字面量：输入框放行标记 + 漂移提示文案。
check('renderer: Esc 输入框放行标记 data-esc-own', rendererAll, 'data-esc-own')
check('renderer: 库目录漂移提示文案', rendererAll, '的索引路径不在当前库目录内')

// ── 0.7.7 ──
// 备份前缀与清理日志前缀都是字符串字面量，压缩不会动它们。
check('renderer: 重复记录清理备份 dup-clean-', rendererAll, 'dup-clean-')
check('renderer: 缩略图存在性自愈日志', rendererAll, '[recordHygiene]')

// ── 0.7.8 ──
// 这一批全是"字符串字面量型"标记，压缩不会动；刻意避开函数名/类名（会被 mangle）。
// 知末分类落库三件套：IPC 通道名、失败日志、preload 桥、备份前缀（与老 reclass- 区分）。
check('main: 知末元信息 ipc 通道 zhimo:fetchMeta', main, 'zhimo:fetchMeta')
check('main: 知末元信息失败日志 zhimo:meta-failed', main, 'zhimo:meta-failed')
check('preload: fetchZhimoMeta bridge', pre, 'fetchZhimoMeta')
check('renderer: 知末重排备份前缀 zhimo-reclass-', rendererAll, 'zhimo-reclass-')
check('renderer: 知末自动分类开关 zhimoAutoCategory', rendererAll, 'zhimoAutoCategory')
// 预览图独立档：文件名后缀 + IPC 通道（两处都在就是真接上了，不是只改了常量）
check('renderer: 预览图后缀 -p1024', rendererAll, '-p1024')
check('main: 预览图 ipc 通道 thumb:preview', main, 'thumb:preview')
// 舞台球贴图池命中的 info 日志（命中即跳过 fetch，是 D 方案的可观测证据）
check('renderer: 贴图池命中日志', rendererAll, '[MaterialBall] 贴图池命中')
// 撤销三档：0 档文案与 esc 探针日志（两者都是纯字面量）
check('renderer: 撤销期 0 档文案', rendererAll, '没有撤销期')
check('renderer: esc 无应答探针日志', rendererAll, 'esc:unanswered')

const qr = find(/contact-qr.*\.png$/)
console.log('contact-qr in bundle:', qr.join(',') || '(none)')
if (qr.length) {
  const bytes = asar.extractFile(abs, qr[0].split('/').join(path.sep)).length
  console.log('  bytes =', bytes, bytes > 100000 ? '(真码，仅本地出包)' : '(占位图)')
}

console.log(failed === 0 ? '\n全部标记通过' : `\n${failed} 项缺失`)
process.exit(failed === 0 ? 0 : 1)
