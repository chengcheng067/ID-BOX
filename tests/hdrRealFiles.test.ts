/**
 * 真实 HDR 样本实测（**不进默认 CI**）。
 *
 * 门控：环境变量 `IDBOX_HDR_REAL=1`。理由：依赖 E 盘 300MB+ 真实素材，
 * 且单次解码 2–6 秒 —— 默认 `npm test` 不该背这个成本。
 *
 * 跑法：
 * ```bash
 * IDBOX_HDR_REAL=1 npx vitest run tests/hdrRealFiles.test.ts
 * ```
 *
 * 断言（不是"能跑就算过"）：
 * 1. 输出宽 = 目标宽，高按比例且为偶数；
 * 2. 进度回调单调递增到 1；
 * 3. 产物缓存文件可被 **three 的 HDRLoader** 解析（这是渲染层能不能显示的唯一契约）；
 * 4. 平均亮度 > 0（全黑说明扫描线解错了 —— RLE 平面/交错搞反时的典型症状）；
 * 5. 源文件只读：跑完 size / mtime 不变。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FloatType } from 'three'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { decodeHdrDownsampled, encodeHdrFile, prepareHdrFile, readHdrSize } from '../src/main/hdrDecode'

const HDR_DIR = process.env['IDBOX_HDR_DIR'] ?? 'E:/hdr'
const ENABLED = process.env['IDBOX_HDR_REAL'] === '1'

const SAMPLES = [
  '21.古月视觉HDR-偏移 V：-0.01平铺：2.hdr',
  '22.古月视觉HDR-偏移U：0.33 V：-0.01平铺：2.hdr',
  '23.古月视觉HDR-偏移U：0.33 V：-0.02平铺：2.hdr'
]

interface Row {
  file: string
  target: number
  ms: number
  rssMb: number
  out: string
  bytes: number
  progressOk: boolean
  meanLuma: number
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024)
}

function maxRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024)
}

describe.skipIf(!ENABLED)('HDR 真实样本（E:/hdr）', () => {
  const rows: Row[] = []

  it('三个真实文件按 2048 / 4096 降采样并落缓存', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-hdr-real-'))
    try {
      for (const name of SAMPLES) {
        const src = path.join(HDR_DIR, name)
        const before = await fs.stat(src)
        const srcSize = await readHdrSize(src)
        expect(srcSize).not.toBeNull()

        for (const target of [2048, 4096]) {
          const ratios: number[] = []
          const t0 = performance.now()
          const res = await decodeHdrDownsampled(src, {
            targetWidth: target,
            onProgress: (r) => ratios.push(r)
          })
          const ms = Math.round(performance.now() - t0)

          const expectW = Math.min(target, srcSize!.width)
          expect(res.width).toBe(expectW)
          expect(res.height % 2).toBe(0)
          expect(res.height).toBe(Math.round((srcSize!.height * expectW) / srcSize!.width))

          // 进度：单调不减且落在 1
          const monotonic = ratios.every((r, i) => i === 0 || r >= (ratios[i - 1] ?? 0))
          expect(monotonic).toBe(true)
          expect(ratios[ratios.length - 1]).toBe(1)

          // 平均亮度：全黑 = 扫描线解错（平面当交错时就是这个症状）
          let sum = 0
          const step = Math.max(4, Math.floor(res.rgbe.length / 4 / 20000) * 4)
          let samples = 0
          for (let o = 0; o < res.rgbe.length; o += step) {
            const e = res.rgbe[o + 3] ?? 0
            if (e === 0) continue
            const f = 2 ** (e - 136)
            sum += ((res.rgbe[o] ?? 0) + (res.rgbe[o + 1] ?? 0) + (res.rgbe[o + 2] ?? 0)) * f
            samples++
          }
          const meanLuma = samples > 0 ? sum / samples / 3 : 0
          expect(meanLuma).toBeGreaterThan(1e-4)

          // 产物必须能被 three 的 HDRLoader 解析（渲染层唯一契约）
          const file = encodeHdrFile(res.width, res.height, res.rgbe)
          const loader = new HDRLoader()
          loader.type = FloatType
          const parsed = loader.parse(
            file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
          )
          expect(parsed.width).toBe(res.width)
          expect(parsed.height).toBe(res.height)

          // 走完整准备链路（含缓存落盘）
          const prepared = await prepareHdrFile({ filePath: src, cacheDir, targetWidth: target })
          const cachedStat = await fs.stat(prepared.cachedPath)
          const again = await prepareHdrFile({ filePath: src, cacheDir, targetWidth: target })
          expect(again.fromCache).toBe(true)

          rows.push({
            file: name.slice(0, 2),
            target,
            ms,
            rssMb: maxRssMb(),
            out: `${res.width}×${res.height}`,
            bytes: cachedStat.size,
            progressOk: monotonic,
            meanLuma: Number(meanLuma.toFixed(3))
          })
        }

        const after = await fs.stat(src)
        expect(after.size).toBe(before.size)
        expect(Math.round(after.mtimeMs)).toBe(Math.round(before.mtimeMs))
      }
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 300_000)

  it('实测数字打印（人读）', () => {
    // eslint-disable-next-line no-console
    console.log(
      '\n[HDR 实测] ' +
        JSON.stringify(
          { rssPeakMb: rssMb(), rows },
          null,
          2
        )
    )
    expect(rows.length).toBe(SAMPLES.length * 2)
  })
})
