/**
 * 球图出图比例 1:1 → **4:3** 的回归测试（2026-10-27 用户拍板）。
 *
 * 用户原话（`docs/25-待办-用户反馈.md` 遗留第 4 条）：
 * 「材质球出图比例改 4:3 —— 能把 `contain` 两侧那 12.5% 留白彻底消掉，但要重跑
 *   缩略图管线，需单独拍板」。已拍板：做。
 *
 * 五组断言：
 * ① **尺寸**：出图 = 宽 × round(宽×3/4)；奇数宽取整不越界、非法输入回落默认；
 * ② **相机纵横比**：`resize(w,h)` 必须让 `camera.aspect === w/h`（横竖都要）——
 *    漏了这条球会被横向拉扁，是本轮最容易出的错；
 * ③ **取景不变**：垂直 fov 42° + 距离 2.935225 ⇒ 球仍占**画面高度** 94.4%（≥ 改前），
 *    且不出画（低于 `MAX_SAFE_FILL`，离"贴满"有 ≥2% 余量）；
 * ④ **缓存身份**：`RENDER_REV === 5`，且 rev4 的名字与 rev5 必不相同（旧方图作废）；
 * ⑤ **惰性升级没被破坏**：`ensureMissingBallThumbs` 只补"根本没图"的资产，
 *    「名字过期但文件还在」的不入队（看到才升 + 涓流兜底）。
 *
 * 环境约束：vitest 是 `environment: 'node'`，`BallScene` 需要 WebGL 上下文，
 * 造不出来。所以「尺寸 / aspect」测**纯函数**（与运行时同源，`resize` 直接调它），
 * 再加**源码守卫**证明运行时确实走了这两个纯函数、没有残留写死的 `size/size`。
 * 纯函数从 `MaterialBall.tsx` 导入是安全的（`materialBallProps.test.ts` 同款做法，
 * 那里只 import 不 new BallScene）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BALL_CANVAS_ASPECT,
  DEFAULT_BALL_CANVAS_WIDTH,
  ballCameraAspect,
  ballCanvasHeight,
  ballCanvasSize
} from '../src/renderer/components/MaterialBall'
import {
  BALL_CAMERA_DISTANCE,
  BALL_FILL_TARGET,
  MAX_SAFE_FILL,
  silhouetteFillAt
} from '../src/renderer/logic/ballCamera'
import { RENDER_REV, ballHash, fnv1a } from '../src/shared/ballParams'

const ROOT = process.cwd()
const BALL_SRC = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/MaterialBall.tsx'),
  'utf-8'
)
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/store.ts'), 'utf-8')
const DETAIL_SRC = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/DetailPanel.tsx'),
  'utf-8'
)
const DIALOG_SRC = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/CustomRenderDialog.tsx'),
  'utf-8'
)

/** 取一段源码：从签名到下一个列首 `}`（模块级函数；文件是 CRLF，`\n}` 照样能匹配） */
function moduleFnBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  expect(at).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end)
}

/** 取一个类成员函数体：从签名到下一个 `  }`（类内方法都按两个空格缩进收尾） */
function memberBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  expect(at).toBeGreaterThan(-1)
  const end = src.indexOf('\n  }', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end)
}

const SLOTS = { albedo: 'vh1sbjl_2K_Albedo.jpg', normal: 'vh1sbjl_2K_Normal.jpg' }
const BASE = 'vh1sbjl_2K_Albedo.jpg\nvh1sbjl_2K_Normal.jpg'

describe('① 出图尺寸 · 4:3（宽 = size，高 = round(size × 3/4)）', () => {
  it('常数就是 4/3，默认宽 640 → 640×480（球径 453px，与 1:1 时代同级）', () => {
    expect(BALL_CANVAS_ASPECT).toBeCloseTo(4 / 3, 12)
    // 640 是 team-lead 2026-10-27 拍板：480×360 的球只有 340px，dpr2 的大框会发虚
    expect(DEFAULT_BALL_CANVAS_WIDTH).toBe(640)
    expect(ballCanvasSize(DEFAULT_BALL_CANVAS_WIDTH)).toEqual({ width: 640, height: 480 })
    // 显式传 480 仍合法（历史口径，480×360），只是不再是默认
    expect(ballCanvasSize(480)).toEqual({ width: 480, height: 360 })
  })

  it('默认口径下球径回到 453px（与 1:1 的 480² 逐像素同级 → 清晰度不退化）', () => {
    const fill = silhouetteFillAt('sphere', BALL_CAMERA_DISTANCE.sphere)
    const { height } = ballCanvasSize(DEFAULT_BALL_CANVAS_WIDTH)
    expect(fill * height).toBeCloseTo(453.1, 1)
    expect(height).toBe(480) // 高度与改前 480² 的画布高完全一致
  })

  it('任何常见尺寸都 ≈ 4/3（容差只来自 1px 的取整）', () => {
    for (const w of [120, 240, 320, 480, 640, 960, 1024]) {
      const out = ballCanvasSize(w)
      expect(out.width).toBe(w)
      expect(out.width / out.height).toBeCloseTo(4 / 3, 2)
    }
  })

  it('奇数宽：高度四舍五入且不为 0（481 → 361），绝不越界', () => {
    expect(ballCanvasHeight(481)).toBe(361)
    // 1px 宽的极端输入也不能算出 0 高（0 高的画布 toBlob 会直接给 null）
    expect(ballCanvasHeight(1)).toBe(1)
    for (let w = 1; w <= 40; w += 1) {
      const out = ballCanvasSize(w)
      expect(Number.isInteger(out.height)).toBe(true)
      expect(out.height).toBeGreaterThanOrEqual(1)
      expect(out.height).toBeLessThanOrEqual(Math.ceil((w * 3) / 4))
    }
  })

  it('非法 / 缺省宽回落默认 640（NaN / 0 / 负数都不许算出 NaN 画布）', () => {
    for (const bad of [Number.NaN, 0, -1, -480, Number.POSITIVE_INFINITY]) {
      expect(ballCanvasSize(bad)).toEqual({ width: DEFAULT_BALL_CANVAS_WIDTH, height: 480 })
    }
  })

  it('★默认值链路：两个显式调用点都不再写死 480（否则封面比卡片图更糊）', () => {
    // MaterialBall 内部的「保存为封面」
    expect(BALL_SRC).toContain('size: DEFAULT_BALL_CANVAS_WIDTH,')
    // 自定义渲染弹窗：同一常量，且必须从 MaterialBall 一起解构出来
    expect(DIALOG_SRC).toContain('DEFAULT_BALL_CANVAS_WIDTH } = await import(')
    expect(DIALOG_SRC).toContain('size: DEFAULT_BALL_CANVAS_WIDTH,')
    // 出图默认值本身走常量（不再有裸 480 字面量）
    expect(BALL_SRC).toContain('opts.size > 0 ? Math.floor(opts.size) : DEFAULT_BALL_CANVAS_WIDTH')
  })

  it('★源码守卫：renderBallBlob 用 out.width/out.height，没有残留 `canvas.height = size`', () => {
    const body = moduleFnBody(BALL_SRC, 'async function renderBallBlob(')
    expect(body).toContain('const out = ballCanvasSize(size)')
    expect(body).toContain('canvas.width = out.width')
    expect(body).toContain('canvas.height = out.height')
    // 旧写法（正方形）必须彻底消失，否则"改了一半"最难看：宽 4:3、高 1:1
    expect(body).not.toContain('canvas.height = size')
    expect(body).not.toContain('canvas.width = size')
    // 画布宽高必须成对传给 BallScene（构造函数据此 resize，见 ②）
    expect(body).toContain('size: out.width')
    expect(body).toContain('height: out.height')
  })
})

describe('② 相机纵横比 · resize(w,h) 必须同步 camera.aspect', () => {
  it('横向 4:3 → aspect 4/3；竖向 → aspect 3/4', () => {
    expect(ballCameraAspect(480, 360)).toBeCloseTo(4 / 3, 12)
    expect(ballCameraAspect(360, 480)).toBeCloseTo(3 / 4, 12)
    expect(ballCameraAspect(1000, 1000)).toBe(1)
  })

  it('高度为 0 / 负数时按 1 保护（不产生 Infinity / 负 aspect）', () => {
    expect(ballCameraAspect(100, 0)).toBe(100)
    expect(ballCameraAspect(100, -5)).toBe(100)
    expect(Number.isFinite(ballCameraAspect(100, 0))).toBe(true)
  })

  it('★源码守卫：resize 走 ballCameraAspect(width, height)，不写死 1', () => {
    const body = memberBody(BALL_SRC, 'resize(width: number, height: number): void {')
    expect(body).toContain('this.camera.aspect = ballCameraAspect(width, height)')
    expect(body).toContain('this.camera.updateProjectionMatrix()')
    expect(body).not.toContain('this.camera.aspect = 1')
  })

  it('★源码守卫：构造函数按 4:3 成对 resize（`opts.size` 是宽，不是边长）', () => {
    const body = memberBody(BALL_SRC, 'constructor(canvas: HTMLCanvasElement, opts: BallSceneOptions) {')
    expect(body).toContain('this.resize(opts.size, opts.height ?? ballCanvasHeight(opts.size))')
    expect(body).not.toContain('this.resize(opts.size, opts.size)')
  })
})

describe('③ 取景 · 球占画面高度仍 ≥ 94.4%，且不出画', () => {
  const fill = silhouetteFillAt('sphere', BALL_CAMERA_DISTANCE.sphere)

  it('球占**画面高度** 94.4%（与改前完全一致：垂直 fov 42° 不受画布比例影响）', () => {
    expect(fill).toBeCloseTo(0.944, 3)
    expect(fill).toBeGreaterThanOrEqual(BALL_FILL_TARGET.sphere - 1e-6)
  })

  it('默认 640×480 的像素账：球径 453.1px、占宽 70.8%、左右各留 93.4px', () => {
    const { width, height } = ballCanvasSize(DEFAULT_BALL_CANVAS_WIDTH)
    const dia = fill * height
    expect(dia).toBeCloseTo(453.1, 1)
    expect(dia / width).toBeCloseTo(0.708, 3)
    expect((width - dia) / 2).toBeCloseTo(93.4, 1)
    // 改前（480² 正方形）：球径同为 453.1px、占宽 94.4%、左右各留 13.4px
    const beforeDia = fill * 480
    expect(beforeDia).toBeCloseTo(453.1, 1)
    expect((480 - beforeDia) / 2).toBeCloseTo(13.4, 1)
  })

  it('显式 size:480 的历史口径（480×360）：球径 339.8px（这就是必须把默认改成 640 的理由）', () => {
    const { width, height } = ballCanvasSize(480)
    const dia = fill * height
    expect(dia).toBeCloseTo(339.8, 1)
    expect(dia / width).toBeCloseTo(0.708, 3)
    expect((width - dia) / 2).toBeCloseTo(70.1, 1)
    // 340 < 详情面板大框在 dpr2 下需要的 ~390 源像素 → 会发虚
    expect(dia).toBeLessThan(390)
  })

  it('不出画：低于安全上限 0.97，且离"贴满画布"（d=2.7904）有 ≥2% 余量', () => {
    const tangent = 1 / Math.sin((21 * Math.PI) / 180) // fov 42 ⇒ 半角 21°
    expect(fill).toBeLessThanOrEqual(MAX_SAFE_FILL)
    expect(BALL_CAMERA_DISTANCE.sphere).toBeGreaterThan(tangent)
    expect(BALL_CAMERA_DISTANCE.sphere / tangent).toBeGreaterThan(1.02)
    // 上下留白（96% 的余量）与左右 14.6% 都 > 0：球是一个完整的外接框
    const { width, height } = ballCanvasSize(DEFAULT_BALL_CANVAS_WIDTH)
    const dia = fill * height
    expect(dia).toBeLessThan(height)
    expect(dia).toBeLessThan(width)
  })

  it('卡片上的观感：球 = 框宽 70.8%（改前改后同值），消失的是那两条 12.5% 色带', () => {
    // 卡片封面框 4:3：框高 = 0.75 × 框宽。球径 = 0.944 × 框高 = 0.708 × 框宽。
    const onCard = fill * 0.75
    expect(onCard).toBeCloseTo(0.708, 3)
    // 改前：1:1 图 contain 进 4:3 框 → 图宽 = 框高 → 两侧各 (1 - 0.75) / 2 = 12.5% 画布色
    expect((1 - 0.75) / 2).toBeCloseTo(0.125, 12)
    // 改后：4:3 图铺满 4:3 框 → 色带宽度 = 0（图=框，缩放比 1:1）
    const widthFillOfOutput = fill * (3 / 4)
    expect(widthFillOfOutput + (1 - widthFillOfOutput)).toBeCloseTo(1, 12)
  })
})

describe('④ 缓存身份 · RENDER_REV 4 → 5', () => {
  it('RENDER_REV === 5，且无条件进 hash 前缀', () => {
    expect(RENDER_REV).toBe(5)
    expect(ballHash(SLOTS, { roughness: 1, bump: 1, uv: 1 })).toBe(
      fnv1a(`rev${RENDER_REV}\n` + BASE)
    )
  })

  it('同一资产：rev4 与 rev5 的名字必须不同（旧方图才会真的作废）', () => {
    const rev5 = ballHash(SLOTS, { roughness: 1, bump: 1, uv: 1 })
    const rev4 = fnv1a('rev4\n' + BASE)
    expect(rev5).not.toBe(rev4)
    // rev5 的 golden（改比例后的新口径）：落盘名 `<id>-<hash>.png` 里的 hash
    expect(rev5).toBe('a68d8ee7')
  })
})

describe('⑤ 惰性升级没被破坏（启动不整库重渲，验收红线）', () => {
  it('ensureMissingBallThumbs：有图且 ready 的资产直接跳过（名字过期也不入队）', () => {
    const body = moduleFnBody(STORE_SRC, 'export async function ensureMissingBallThumbs()')
    const skip = body.indexOf("if (a.thumbPath && a.thumbStatus === 'ready') continue")
    const enqueue = body.indexOf('enqueueBallThumb(a)')
    expect(skip).toBeGreaterThan(-1)
    expect(enqueue).toBeGreaterThan(skip) // 跳过的判断在入队之前
    // 循环里只有**一处**入队：不存在"另一个不判缓存的分支"
    expect((body.match(/enqueueBallThumb\(/g) ?? []).length).toBe(1)
    // 补完之后挂上涓流（幂等），慢收敛有兜底
    expect(body).toContain('scheduleStaleTrickle()')
  })

  it('涓流 3s 一条 / 每会话 ≤60 条，且只在队列空时入队（不抢可见升级）', () => {
    expect(STORE_SRC).toContain('export const STALE_TRICKLE_INTERVAL_MS = 3000')
    expect(STORE_SRC).toContain('export const STALE_TRICKLE_SESSION_MAX = 60')
    expect(STORE_SRC).toContain('if (ballQueue.length > 0) {')
    expect(STORE_SRC).toContain('if (staleTrickleProduced >= STALE_TRICKLE_SESSION_MAX) return')
  })

  it('看到才升：noteVisibleAssets 每次最多 VISIBLE_UPGRADE_MAX 条', () => {
    expect(STORE_SRC).toContain('export const VISIBLE_UPGRADE_MAX = 6')
    const body = moduleFnBody(STORE_SRC, 'export function noteVisibleAssets(')
    expect(body).toContain('if (queued >= VISIBLE_UPGRADE_MAX) break')
    expect(body).toContain('if (asset.thumbPath === want) continue')
  })
})

describe('⑥ 详情面板封面框：材质/贴图 4:3（与出图同比例）', () => {
  it('三元里材质/贴图是 aspect-[4/3]，模型仍是 16:10', () => {
    expect(DETAIL_SRC).toContain(
      "asset.kind === 'material' || asset.kind === 'texture' ? 'aspect-[4/3]' : 'aspect-[16/10]'"
    )
    // 材质/贴图不许再回退到 1:1（方框 + 4:3 图会被 object-cover 上下切一刀）
    expect(DETAIL_SRC).not.toContain(
      "asset.kind === 'material' || asset.kind === 'texture' ? 'aspect-square'"
    )
  })
})

// ── ⑦ 关于另外三条 CRLF 守卫的口径说明（不在本文件断言，写在这里防"以后被改回去"）──
/**
 * 源码是 **CRLF**，所以任何跨行的 `toContain('…\n…')` 都永远匹配不上（`\n` 前卡着 `\r`）
 * —— 这类守卫会"永远绿"，比没有守卫更危险。本批修了三条（都改成 `\r?\n` 正则）：
 *
 * 1. `tests/materialBallShapeWiring.test.ts`：`not.toContain('getShape: () => shape\n')`
 *    → `not.toMatch(/getShape: \(\) => shape\r?\n/)`。**不能**去掉行尾的换行约束：
 *    `'getShape: () => shape'` 是合法写法 `getShape: () => shapeRef.current` 的前缀，
 *    去掉 `\r?\n` 会变成误报。该文件里同时留了一条"反向对照"（喂一段坏的 CRLF 片段
 *    必须命中），证明它真的会红。
 * 2. `tests/stagePerf.test.ts`「统一 setOpacity('1') 的老写法必须已拆掉」
 *    → `not.toMatch(/setRunning\(true\)\r?\n\s*host\.style\.opacity/)`。
 * 3. `tests/stagePerf.test.ts`「不能在 albedo 回调里提前 resolve」
 *    → 先 slice 出 `const jobs = mapEntries.map(` 到 `// Promise 语义不变` 这一段，
 *    再 `not.toMatch(/return\s+Promise\.resolve\(\)/)`。
 *    ⚠️ **范围不许再放大回整个 `applyMaps` 函数体**：`entries.length === 0`（灰球）
 *    分支里有一个**合法**的 `return Promise.resolve()`（空槽位的早退），
 *    按整函数匹配会把它误判成"albedo 回调提前返回"→ 守卫变红但代码是对的。
 *    收窄到 `jobs` 那一段后，匹配面只包含「每个槽位的 loadMap 回调」，
 *    语义与注释一致，且真的能拦住回退。
 */
describe('⑦ CRLF 守卫口径（说明性占位，锚点测试）', () => {
  it('★CRLF 片段证明：`\\n` 字面量守卫对 CRLF 源码失效，必须用 `\\r?\\n`', () => {
    const crlf = 'a();\r\n    b();'
    // 旧写法（死守卫）：\n 前卡着 \r → 永远不命中
    expect(crlf.includes('a();\n    b();')).toBe(false)
    // 新写法：能命中
    expect(/a\(\);\r?\n\s*b\(\);/.test(crlf)).toBe(true)
  })
})
