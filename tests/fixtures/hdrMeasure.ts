/**
 * HDR 解码内存/耗时实测夹具（**不是测试**，供人工跑）：
 *
 * ```bash
 * node --experimental-strip-types tests/fixtures/hdrMeasure.ts "E:/hdr/xxx.hdr" 2048
 * ```
 *
 * 单独进程跑的理由：vitest 进程本身背着 three.js / 收集器 ≈ 100MB+ RSS，
 * 在测试里读 `process.memoryUsage()` 得到的峰值会被这个基线污染。
 * 这里从干净进程起步，只加载 `src/main/hdrDecode.ts`（零第三方依赖）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 动态 import（带 `.ts` 后缀）：本文件由 `node --experimental-strip-types` 直接执行，
 * 运行时必须写全扩展名；而 `tsc` 默认禁止 import 路径带 `.ts`（TS5097）。
 * 用变量说明符 + `typeof import(...)` 断言，两边都满足：运行时拿到真模块，类型也不丢。
 */
type HdrDecodeModule = typeof import('../../src/main/hdrDecode')
const hdrDecodeUrl = new URL('../../src/main/hdrDecode.ts', import.meta.url).href
const { decodeHdrDownsampled, encodeHdrFile, readHdrSize } =
  (await import(hdrDecodeUrl)) as HdrDecodeModule

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024)
}

const filePath = process.argv[2] ?? ''
const target = Number.parseInt(process.argv[3] ?? '2048', 10)

if (!filePath) {
  console.error('usage: node --experimental-strip-types tests/fixtures/hdrMeasure.ts <file.hdr> [targetWidth]')
  process.exit(2)
}

const srcSize = await readHdrSize(filePath)
const rssStart = rssMb()
let rssPeak = rssStart

const t0 = performance.now()
const res = await decodeHdrDownsampled(filePath, {
  targetWidth: target,
  onProgress: () => {
    const now = rssMb()
    if (now > rssPeak) rssPeak = now
  }
})
const ms = Math.round(performance.now() - t0)

const written = encodeHdrFile(res.width, res.height, res.rgbe)
const tmp = path.join(os.tmpdir(), `.measure-${process.pid}.hdr`)
try {
  await fs.writeFile(tmp, written)
} finally {
  await fs.rm(tmp, { force: true }).catch(() => {})
}

console.log(
  JSON.stringify({
    file: path.basename(filePath),
    sourceBytes: (await fs.stat(filePath)).size,
    sourceSize: srcSize,
    target,
    ms,
    rssStartMb: rssStart,
    rssPeakMb: rssPeak,
    rssDeltaMb: rssPeak - rssStart,
    out: `${res.width}×${res.height}`,
    outBytes: res.rgbe.length,
    cachedBytes: written.length,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024)
  })
)
