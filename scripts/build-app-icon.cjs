/**
 * 品牌资源构建脚本（2026-10 用户要求「图标和 Logo 换一下」「关于页做上打赏和反馈」）。
 *
 * 一次产出三类资源，全部**从像素算**、不硬编码坐标（换图的人不用改代码）：
 *
 * ① 应用图标 `build/icon.png`（1024×1024）
 *    源：`resources/brand/logo3.png`（4000×3000 设计稿，中间一枚圆角方形徽标）
 *    做法：扫不透明像素求紧致 bbox → 补正方形 → resize 1024 → 写 PNG。
 *
 * ② 顶栏 Logo `src/renderer/assets/brand/mark.png`（256×256，与 ① 同一枚徽标）
 *    为什么要复制一份而不是让 renderer 直接吃 `build/icon.png`：
 *    `build/` 是 electron-builder 的素材目录（不进 asar、不参与 Vite 打包），
 *    renderer 想拿到图必须走 Vite 的 `import`（产物是哈希 URL）；
 *    跨目录 `import '../../../../build/icon.png'` 会让两套构建相互耦合
 *    （builder 的素材被 vite 依赖、vite 的产物又进不进 asar 的 build/）。
 *    所以约定：`resources/brand/*` 放**原图留档**，`src/renderer/assets/brand/*` 放**构建产物**，
 *    两边同源同步由本脚本一次写成，禁止手工各改一边。
 *
 * ③ 关于页二维码 `src/renderer/assets/brand/donate-qr.png` / `contact-qr.png`（512×512）
 *    源：`resources/brand/donate-wechat.jpg` / `contact-wechat.jpg`（微信导出图）
 *
 *    ⚠️ **反馈码（contact）的源图是可选的**，因为本仓库是公开的：
 *    真实微信二维码属于个人信息，不进公开仓库（`.gitignore` 里排掉 `contact-wechat.jpg`）。
 *    仓库里提交的是 `contact-qr.png` 的**占位图**（浅灰底 + 叉）。
 *    要换成你自己的码：把图放到 `resources/brand/contact-wechat.local.jpg`
 *    （或 `contact-wechat.jpg`，本地未跟踪）→ 跑一次本脚本，产物就替换掉了。
 *    找不到源图时**跳过并保留现有产物**，不会报错、不会把占位图弄坏。
 *
 *    为什么要裁：微信导出的赞赏码整图是一张绿底海报，二维码只占宽度的 ~50%；
 *    原图直接塞进 168px 的位置，码面只剩 80px 左右，**扫不出来**。
 *    这里自动定位二维码本体、四周补 ~8% 白边（静区），再缩到 512（168px 显示时 3× DPR 也不糊）。
 *    定位算法：逐行/逐列统计「暗像素」数量，取最长的连续高密度带（二维码区），
 *    相对阈值 = 最大值的 45% —— 标题文字 / 头像 / 底部 logo 的暗像素密度都远低于二维码。
 *
 * 运行（⚠️ 环境里常驻 ELECTRON_RUN_AS_NODE=1，必须 env -u 掉才是真的 Electron 主进程，
 * 否则 require('electron') 只拿到可执行文件路径字符串）：
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/build-app-icon.cjs
 *
 * 可选参数：
 *   --no-icon         不写 build/icon.png
 *   --no-mark         不写顶栏 mark.png
 *   --no-qr           不重建二维码裁图
 *   --no-transparent  图标跳过泛洪去白（debug 用，产出的四角会是白色）
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

// ── 输入（原图留档）──────────────────────────────────────────
const SRC_LOGO = path.join(ROOT, 'resources', 'brand', 'logo3.png')
const SRC_DONATE = path.join(ROOT, 'resources', 'brand', 'donate-wechat.jpg')
/**
 * 反馈二维码源图：**可选**。优先 `*.local.jpg`（本机私有、被 gitignore），
 * 其次 `contact-wechat.jpg`。两者都没有 → 跳过重建，保留仓库里的占位图。
 */
const SRC_CONTACT_LOCAL = path.join(ROOT, 'resources', 'brand', 'contact-wechat.local.jpg')
const SRC_CONTACT_FALLBACK = path.join(ROOT, 'resources', 'brand', 'contact-wechat.jpg')
const SRC_CONTACT = fs.existsSync(SRC_CONTACT_LOCAL) ? SRC_CONTACT_LOCAL : SRC_CONTACT_FALLBACK

// ── 输出（Vite 打包的构建产物 / builder 素材）────────────────
const OUT_ICON = path.join(ROOT, 'build', 'icon.png')
const OUT_MARK = path.join(ROOT, 'src', 'renderer', 'assets', 'brand', 'mark.png')
const OUT_DONATE_QR = path.join(ROOT, 'src', 'renderer', 'assets', 'brand', 'donate-qr.png')
const OUT_CONTACT_QR = path.join(ROOT, 'src', 'renderer', 'assets', 'brand', 'contact-qr.png')

/** 应用图标边长（Windows 图标标准 256 的整数倍，builder 转 ico 时可下采样） */
const ICON_SIZE = 1024
/**
 * 顶栏 Logo 的边长。顶栏只显示 22 CSS px（3× DPR = 66px），
 * 给 1024 会让 `mark.png` 变成 ~176KB 的白白浪费（renderer bundle 里最大的一张图），
 * 256 已足够 4× DPR 清晰，产物约 20KB。
 */
const MARK_SIZE = 256
/** 二维码裁图边长（显示 168 CSS px，3× DPR 仍有余量） */
const QR_SIZE = 512
/** 二维码四周白边（静区）比例：每边 8% */
const QR_QUIET_ZONE = 0.08

/** 三通道都 ≥ 该值 → 认为是可以被泛洪抹掉的「白底」 */
const WHITE_MIN = 246
/** alpha 低于该值视为已透明（crop / resize 后会有半透明边缘像素） */
const ALPHA_MIN = 8
/** 三通道都 ≤ 该值 → 认为是一个「暗像素」（二维码模块） */
const DARK_MAX = 100

const argv = new Set(process.argv.slice(2))
const wantIcon = !argv.has('--no-icon')
const wantMark = !argv.has('--no-mark')
const wantQr = !argv.has('--no-qr')
const wantTransparent = !argv.has('--no-transparent')

// ── 通用像素工具 ─────────────────────────────────────────────

/** BGRA 位图里取某个像素的 [r, g, b, a]（nativeImage.toBitmap 在 Windows 上是 BGRA） */
function readPixel(bitmap, width, x, y) {
  const i = (y * width + x) * 4
  return [bitmap[i + 2], bitmap[i + 1], bitmap[i], bitmap[i + 3]]
}

/** 端序无关的像素打印：统一转成 #RRGGBBAA */
function formatPixel([r, g, b, a]) {
  const hex = (v) => v.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`
}

/** 是否「白底候选」：不透明且三通道都很亮 */
function isWhiteish(bitmap, width, x, y) {
  const [r, g, b, a] = readPixel(bitmap, width, x, y)
  return a >= ALPHA_MIN && r >= WHITE_MIN && g >= WHITE_MIN && b >= WHITE_MIN
}

/** 是否「暗像素」（二维码模块 / 文字） */
function isDark(bitmap, width, x, y) {
  const [r, g, b] = readPixel(bitmap, width, x, y)
  return r <= DARK_MAX && g <= DARK_MAX && b <= DARK_MAX
}

/**
 * 从画布四条边做连通泛洪，把与边缘连通的白底 alpha 置 0。
 * 用显式栈而不是递归 —— 4000×3000 用递归会爆栈。
 * 返回 `{ flooded, seeds }`。
 */
function floodFillBackground(bitmap, width, height) {
  const visited = new Uint8Array(width * height)
  const stack = []

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const idx = y * width + x
    if (visited[idx] === 1) return
    if (!isWhiteish(bitmap, width, x, y)) return
    visited[idx] = 1
    stack.push(idx)
  }

  for (let x = 0; x < width; x += 1) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y)
    push(width - 1, y)
  }
  const seeds = stack.length

  let flooded = 0
  while (stack.length > 0) {
    const idx = stack.pop()
    const x = idx % width
    const y = (idx - x) / width
    // 抹成透明（保留 RGB，避免缩小时边缘出现黑边）
    bitmap[idx * 4 + 3] = 0
    flooded += 1
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  return { flooded, seeds }
}

/** 泛洪自检：抹掉的面积要像「外围白底」，不能把徽标本体吃掉 */
function verifyFloodFill({ flooded, seeds }, total) {
  if (seeds === 0) throw new Error('四条边上没找到白底像素：设计稿可能不是白画布，请用 --no-transparent')
  const ratio = flooded / total
  if (ratio < 0.2 || ratio > 0.85) {
    throw new Error(
      `泛洪面积异常：抹掉 ${(ratio * 100).toFixed(1)}%，疑似阈值吃进徽标本体，请检查 WHITE_MIN`
    )
  }
  return ratio
}

/** 扫非透明像素的紧致 bbox；返回 null 表示整张图都是透明的（异常） */
function findOpaqueBBox(bitmap, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = bitmap[(y * width + x) * 4 + 3]
      if (a < ALPHA_MIN) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** 统计四条边上的「不透明且纯白」像素占比 —— 用来验证四边没有大片纯白 */
function edgeWhiteReport(bitmap, width, height) {
  const edges = { top: 0, bottom: 0, left: 0, right: 0 }
  for (let x = 0; x < width; x += 1) {
    if (isWhiteish(bitmap, width, x, 0)) edges.top += 1
    if (isWhiteish(bitmap, width, x, height - 1)) edges.bottom += 1
  }
  for (let y = 0; y < height; y += 1) {
    if (isWhiteish(bitmap, width, 0, y)) edges.left += 1
    if (isWhiteish(bitmap, width, width - 1, y)) edges.right += 1
  }
  return {
    top: edges.top / width,
    bottom: edges.bottom / width,
    left: edges.left / height,
    right: edges.right / height
  }
}

/**
 * 在一维「暗像素计数」里挑出二维码所在的那条密集带。
 *
 * 为什么不是「最长连续段」：二维码内部有些行几乎全白（模块间隙），
 * 密集行会被切成十几段，最长的一段只有几十像素高。
 * 所以先按阈值取候选行/列，再把**间隔不大的候选合并成一簇**（maxGap 默认 4% 边长），
 * 最后取跨度最大的一簇——二维码是一簇，底部「微信支付」logo 文字是另一簇（更短）。
 *
 * @param counts 每行 / 每列的暗像素数
 * @param minRatio 相对阈值：≥ 最大值 × 该比例才算候选（默认 0.45）
 * @param maxGap 允许合并的最大间隔（像素）
 * @returns `{ start, end }` 闭区间；找不到返回 null
 */
function pickDenseBand(counts, minRatio, maxGap) {
  const max = Math.max(...counts)
  if (max === 0) return null
  const threshold = max * minRatio

  let best = null
  let cur = null
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] < threshold) continue
    if (cur && i - cur.end <= maxGap) {
      cur.end = i
      cur.sum += counts[i]
    } else {
      if (cur) {
        if (!best || cur.end - cur.start > best.end - best.start) best = cur
      }
      cur = { start: i, end: i, sum: counts[i] }
    }
  }
  if (cur && (!best || cur.end - cur.start > best.end - best.start)) best = cur
  return best ? { start: best.start, end: best.end } : null
}

/**
 * 定位二维码本体的 bbox。
 *
 * 逐行 / 逐列统计暗像素数量：
 *   1. 行方向先用 pickDenseBand 取二维码所在的垂直带；
 *   2. 只在这条带内重算列计数，再取水平带。
 * 二维码内部的暗像素密度稳定在 40%~50%，而标题文字 / 头像照片 / 底部 logo 的密度低一个量级，
 * 所以 45% 相对阈值能把它们全部排除。
 */
function findQrBounds(bitmap, width, height) {
  const rowDark = new Int32Array(height)
  for (let y = 0; y < height; y += 1) {
    let n = 0
    for (let x = 0; x < width; x += 1) if (isDark(bitmap, width, x, y)) n += 1
    rowDark[y] = n
  }
  const rowBand = pickDenseBand(rowDark, 0.45, Math.max(4, Math.round(height * 0.04)))
  if (!rowBand) throw new Error('没找到二维码的纵向区间（整图没有成片的暗像素）')

  const colDark = new Int32Array(width)
  for (let x = 0; x < width; x += 1) {
    let n = 0
    for (let y = rowBand.start; y <= rowBand.end; y += 1) if (isDark(bitmap, width, x, y)) n += 1
    colDark[x] = n
  }
  const colBand = pickDenseBand(colDark, 0.45, Math.max(4, Math.round(width * 0.04)))
  if (!colBand) throw new Error('没找到二维码的横向区间')

  return {
    x: colBand.start,
    y: rowBand.start,
    width: colBand.end - colBand.start + 1,
    height: rowBand.end - rowBand.start + 1
  }
}

/** 写文件前建目录，日志统一格式 */
function writePng(buffer, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buffer)
  console.log(`[brand] 写出 ${path.relative(ROOT, file)}（${buffer.length} 字节）`)
}

// ── ① / ② 应用图标 + 顶栏 Logo ───────────────────────────────

function buildIcon() {
  if (!fs.existsSync(SRC_LOGO)) throw new Error(`找不到源图：${SRC_LOGO}`)

  const source = nativeImage.createFromPath(SRC_LOGO)
  if (source.isEmpty()) throw new Error(`源图无法解码：${SRC_LOGO}`)
  const size = source.getSize()
  const bitmap = source.toBitmap()
  const total = size.width * size.height
  console.log(`[brand] ① 图标源图 ${path.relative(ROOT, SRC_LOGO)} ${size.width}×${size.height}`)

  const cornersBefore = [
    ['左上', 0, 0],
    ['右上', size.width - 1, 0],
    ['左下', 0, size.height - 1],
    ['右下', size.width - 1, size.height - 1]
  ].map(([name, x, y]) => `${name} ${formatPixel(readPixel(bitmap, size.width, x, y))}`)
  console.log(`[brand]   源图四角：${cornersBefore.join(' · ')}`)

  // 画布底色判定：四角已透明 → 无需去白；四角是白 → 连通泛洪抹掉；都不是 → 报错
  const cornerPixels = [
    readPixel(bitmap, size.width, 0, 0),
    readPixel(bitmap, size.width, size.width - 1, 0),
    readPixel(bitmap, size.width, 0, size.height - 1),
    readPixel(bitmap, size.width, size.width - 1, size.height - 1)
  ]
  const alreadyTransparent = cornerPixels.every((px) => px[3] < ALPHA_MIN)
  const cornersAreWhite = cornerPixels.every((px) => px[3] >= ALPHA_MIN && px[0] >= WHITE_MIN && px[1] >= WHITE_MIN && px[2] >= WHITE_MIN)

  if (!wantTransparent) {
    console.log('[brand]   跳过泛洪去白（--no-transparent）')
  } else if (alreadyTransparent) {
    console.log('[brand]   源图四角已经是透明底，无需泛洪去白')
  } else if (cornersAreWhite) {
    const flood = floodFillBackground(bitmap, size.width, size.height)
    const ratio = verifyFloodFill(flood, total)
    console.log(
      `[brand]   泛洪去白：种子 ${flood.seeds} px，抹掉 ${flood.flooded} px（${(ratio * 100).toFixed(1)}%）`
    )
  } else {
    throw new Error('画布四角既不是透明也不是白色，无法安全去底（请人工处理源图）')
  }

  const bbox = findOpaqueBBox(bitmap, size.width, size.height)
  if (!bbox) throw new Error('扫不到任何不透明像素，源图可能整张透明')
  console.log(
    `[brand]   非透明 bbox：x=${bbox.x} y=${bbox.y} w=${bbox.width} h=${bbox.height}` +
      `（占源图 ${((bbox.width * bbox.height) / total * 100).toFixed(1)}%）`
  )

  // 补成正方形再裁（避免 resize 到 1024×1024 时把徽标拉扁），并夹在画布内
  const side = Math.max(bbox.width, bbox.height)
  const cx = bbox.x + bbox.width / 2
  const cy = bbox.y + bbox.height / 2
  const cropX = Math.max(0, Math.min(Math.round(cx - side / 2), size.width - side))
  const cropY = Math.max(0, Math.min(Math.round(cy - side / 2), size.height - side))
  const cropW = Math.min(side, size.width - cropX)
  const cropH = Math.min(side, size.height - cropY)
  console.log(`[brand]   正方形裁剪：x=${cropX} y=${cropY} w=${cropW} h=${cropH}`)

  const cropped = source.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
  const resized = cropped.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: 'best' })
  const outSize = resized.getSize()
  if (outSize.width !== ICON_SIZE || outSize.height !== ICON_SIZE) {
    throw new Error(`输出尺寸异常：${outSize.width}×${outSize.height}，期望 ${ICON_SIZE}×${ICON_SIZE}`)
  }
  const png = resized.toPNG()
  if (png.length === 0) throw new Error('toPNG() 产出为空')

  if (wantIcon) writePng(png, OUT_ICON)
  if (wantMark) {
    // 顶栏只显示 22 CSS px，单独缩到 256（不要复制 1024 的大图进 renderer bundle）
    const markImg = cropped.resize({ width: MARK_SIZE, height: MARK_SIZE, quality: 'best' })
    const markPng = markImg.toPNG()
    if (markPng.length === 0) throw new Error('mark.png 编码为空')
    writePng(markPng, OUT_MARK)
    console.log(`[brand]   顶栏 mark 尺寸：${markImg.getSize().width}×${markImg.getSize().height}（期望 ${MARK_SIZE}）`)
  }

  // 产物自检：尺寸 / 四角 / 四边纯白占比
  const outBitmap = resized.toBitmap()
  const outCorners = [
    ['左上', 0, 0],
    ['右上', ICON_SIZE - 1, 0],
    ['左下', 0, ICON_SIZE - 1],
    ['右下', ICON_SIZE - 1, ICON_SIZE - 1]
  ].map(([name, x, y]) => ({ name, px: readPixel(outBitmap, ICON_SIZE, x, y) }))
  console.log(`[brand]   产物尺寸：${outSize.width}×${outSize.height}（期望 ${ICON_SIZE}×${ICON_SIZE}）`)
  console.log(`[brand]   产物四角：${outCorners.map((c) => `${c.name} ${formatPixel(c.px)}`).join(' · ')}`)

  const edges = edgeWhiteReport(outBitmap, ICON_SIZE, ICON_SIZE)
  console.log(
    `[brand]   四边纯白占比：上 ${(edges.top * 100).toFixed(1)}% · 下 ${(edges.bottom * 100).toFixed(1)}% · ` +
      `左 ${(edges.left * 100).toFixed(1)}% · 右 ${(edges.right * 100).toFixed(1)}%`
  )

  if (wantTransparent && !alreadyTransparent) {
    // 去白成功后四角必须透明（圆角方形徽标的四角在裁剪框内，本来就是背景）
    const opaqueCorners = outCorners.filter((c) => c.px[3] >= ALPHA_MIN)
    if (opaqueCorners.length > 0) {
      throw new Error(
        `四角仍有不透明像素（${opaqueCorners.map((c) => `${c.name} ${formatPixel(c.px)}`).join(' · ')}），去白没生效`
      )
    }
  }
  for (const [edge, ratio] of Object.entries(edges)) {
    if (ratio > 0.5) {
      throw new Error(`边 ${edge} 上纯白占比 ${(ratio * 100).toFixed(1)}% > 50%，四边仍有大片纯白`)
    }
  }
  console.log('[brand]   图标自检通过')
}

// ── ③ 二维码裁图 ─────────────────────────────────────────────

/** 裁一张二维码：紧致 bbox + 每边 8% 静区 → 方图 → QR_SIZE */
function buildQr(srcPath, outPath, label) {
  if (!fs.existsSync(srcPath)) throw new Error(`找不到源图：${srcPath}`)
  const src = nativeImage.createFromPath(srcPath)
  if (src.isEmpty()) throw new Error(`源图无法解码：${srcPath}`)
  const size = src.getSize()
  const bitmap = src.toBitmap()

  const qr = findQrBounds(bitmap, size.width, size.height)
  const pad = Math.round(Math.max(qr.width, qr.height) * QR_QUIET_ZONE)
  const side = Math.max(qr.width, qr.height) + pad * 2
  const cx = qr.x + qr.width / 2
  const cy = qr.y + qr.height / 2

  let cropX = Math.round(cx - side / 2)
  let cropY = Math.round(cy - side / 2)
  let cropW = side
  let cropH = side
  // 夹进源图边界：夹紧后仍保持正方形（取可行的最大边长）
  cropW = Math.min(cropW, size.width, size.height)
  cropH = cropW
  cropX = Math.max(0, Math.min(cropX, size.width - cropW))
  cropY = Math.max(0, Math.min(cropY, size.height - cropH))

  console.log(
    `[brand] ③ ${label} 源图 ${size.width}×${size.height} → 二维码 bbox ` +
      `x=${qr.x} y=${qr.y} w=${qr.width} h=${qr.height}（码面占宽 ${((qr.width / size.width) * 100).toFixed(1)}%）`
  )

  const cropped = src.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
  const resized = cropped.resize({ width: QR_SIZE, height: QR_SIZE, quality: 'best' })
  const png = resized.toPNG()
  if (png.length === 0) throw new Error('toPNG() 产出为空')
  writePng(png, outPath)

  // 产物自检：暗像素 bbox 应几乎铺满（说明码是主体），四角必须是白的（静区足够）
  const outBmp = resized.toBitmap()
  const dark = findQrBounds(outBmp, QR_SIZE, QR_SIZE)
  const coverage = Math.max(dark.width, dark.height) / QR_SIZE
  const corners = [
    readPixel(outBmp, QR_SIZE, 0, 0),
    readPixel(outBmp, QR_SIZE, QR_SIZE - 1, 0),
    readPixel(outBmp, QR_SIZE, 0, QR_SIZE - 1),
    readPixel(outBmp, QR_SIZE, QR_SIZE - 1, QR_SIZE - 1)
  ]
  console.log(
    `[brand]   ${label} 产物 ${QR_SIZE}×${QR_SIZE}，码面覆盖 ${(coverage * 100).toFixed(1)}%，` +
      `四角 ${corners.map(formatPixel).join(' · ')}`
  )
  if (coverage < 0.7) throw new Error(`${label}：裁剪后码面只占 ${(coverage * 100).toFixed(1)}%，裁剪失败`)
  if (corners.some((px) => px[0] < 240 || px[1] < 240 || px[2] < 240)) {
    throw new Error(`${label}：裁剪后四角不是白色，静区不足（深色主题下会扫不出来）`)
  }
  console.log(`[brand]   ${label} 自检通过`)
}

function main() {
  buildIcon()
  if (wantQr) {
    buildQr(SRC_DONATE, OUT_DONATE_QR, '赞赏码')
    // 反馈码源图可能不存在（公开仓库不带真实二维码）→ 跳过，保留已有产物（占位图）
    if (fs.existsSync(SRC_CONTACT)) {
      buildQr(SRC_CONTACT, OUT_CONTACT_QR, '加好友码')
    } else {
      console.log(
        '[brand] 未找到 contact-wechat.local.jpg / contact-wechat.jpg → 跳过反馈码，' +
          '保留仓库自带的占位图（替换方法见本文件头部 ③）'
      )
    }
  }
  console.log('[brand] 全部完成')
}

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  try {
    main()
    app.exit(0)
  } catch (err) {
    console.error(`[brand] 失败：${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  }
})
