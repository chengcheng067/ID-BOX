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

check('main: update:check ipc', main, 'update:check')
check('main: github releases/latest', main, 'releases/latest')
check('main: deleteOneThumb (精确删图)', main, 'deleteOneThumb')
check('preload: checkUpdate bridge', pre, 'checkUpdate')
check('renderer: startAutoCheck', renderer, 'startAutoCheck')
check('renderer: ballThumbTarget (球图不复用通配删)', renderer, 'ballThumbTarget')
check('renderer: regenThumbSweep', renderer, 'regenThumbSweep')
check('renderer: autoCheckUpdate 设置项', renderer, 'autoCheckUpdate')
check('css: --preview-tint token', css, '--preview-tint')
check('css: folder-stage-leave 260ms', css, 'folder-stage-leave')

const qr = find(/contact-qr.*\.png$/)
console.log('contact-qr in bundle:', qr.join(',') || '(none)')
if (qr.length) {
  const bytes = asar.extractFile(abs, qr[0].split('/').join(path.sep)).length
  console.log('  bytes =', bytes, bytes > 100000 ? '(真码，仅本地出包)' : '(占位图)')
}

console.log(failed === 0 ? '\n全部标记通过' : `\n${failed} 项缺失`)
process.exit(failed === 0 ? 0 : 1)
