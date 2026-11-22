/**
 * T2 首页自定义（docs/55 §2.1 / §4-T2）接线守卫 + 纯函数单测。
 *
 * ## 为什么主要是源码守卫
 * `vitest.config.ts` 是 `environment: 'node'`，全仓无 jsdom / RTL —— 与
 * `tests/classifyUiWiring.test.ts` 同款 `readSrc()` 范式：读文件文本 + 断言关键接线点。
 * **行为**由本文件里对 `resolveTidePalette` 的真跑用例兜住；UI 只守"控件有没有接上"。
 *
 * ## 每条守卫防的具体退化
 * | # | 守卫 | 防的退化 |
 * |---|---|---|
 * | 1 | 纯函数体不含 `backgroundColor:` | Q-1 底色被顺手覆盖，出现色差接缝 |
 * | 2 | 色板 + HEX 同字段 | Q-2 只剩一种输入 / 两个状态不同步 |
 * | 3 | 浅深各一组 + observer 按主题取 | Q-3 切主题用了另一套自定义色 |
 * | 4 | 单滑块 clamp + 依赖数组 | Q-4 脏值越界 / 改设置不重绘 |
 * | 5 | bg:// 四处同步 + 越界检查 | Q-5 图片读不到 / 目录穿越 |
 * | 6 | 壁纸层 fixed 全屏 / 无压暗 / 粒子透明底 | 2026-11-22 壁纸全屏化回退（压暗复活 / 图片层缩回内容区） |
 * | 7 | data-guide 锚点 | T4 引导找不到真实元素 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveTidePalette } from '../src/renderer/components/home/HomeParticles'

/** 相对仓库根读源码，换行归一（工作区 CRLF，切片断言不能被换行符干扰）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释：本仓注释里就写着要防的东西（如"不用 backdrop-filter"），不剥会误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 取一个函数从 `{` 到配对 `}` 的**函数体**（大括号计数，字符串内无花括号）。 */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `找不到函数签名：${signature}`).toBeGreaterThanOrEqual(0)
  const brace = src.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(brace, i + 1)
    }
  }
  throw new Error(`函数大括号不配对：${signature}`)
}

const PARTICLES = readSrc('src/renderer/components/home/HomeParticles.tsx')
const PARTICLES_CODE = stripComments(PARTICLES)
const SETTINGS_SRC = readSrc('src/renderer/components/SettingsDialog.tsx')
const SETTINGS_CODE = stripComments(SETTINGS_SRC)
const COVER = readSrc('src/renderer/components/home/HomeCover.tsx')
const COVER_CODE = stripComments(COVER)

/** 首页卡区域（从 `title="首页"` 到该卡结束），确保控件断言不误伤别的 tab。 */
function homeCard(src: string): string {
  const start = src.indexOf('title="首页"')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('</SettingsCard>', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

const HOME_CARD = homeCard(SETTINGS_CODE)

describe('T2 · resolveTidePalette 纯函数', () => {
  type Base = Parameters<typeof resolveTidePalette>[0]
  const LIGHT_BASE: Base = {
    backgroundColor: '#f8fafc',
    waterColor: '#007ad6',
    crestColor: '#d9a863',
    opacity: 1,
    alphaScale: 2,
    density: 1.5,
    waveHeight: 0.65,
    particleSize: 2,
    interactive: true,
    swell: 1,
    swellRadius: 0.9,
    parallax: 1,
    clickRipples: true
  }
  const DARK_BASE: Base = { ...LIGHT_BASE, backgroundColor: '#111113', waterColor: '#0091ff', crestColor: '#efdabd', opacity: 0.85 }

  it('只覆盖水体 / 浪峰 / 浪高，backgroundColor 原样保留（Q-1）', () => {
    const body = functionBody(PARTICLES_CODE, 'export function resolveTidePalette')
    expect(body).toContain('waterColor: validHexOrNull(custom?.waterColor) ?? base.waterColor')
    expect(body).toContain('crestColor: validHexOrNull(custom?.crestColor) ?? base.crestColor')
    expect(body).toContain('waveHeight: clampWaveHeight(waveHeight)')
    expect(body).not.toContain('backgroundColor:')
    // 真正的底色仍由 buildSettings 里的 readCanvasBackground 决定
    expect(PARTICLES_CODE).toContain('backgroundColor: readCanvasBackground(palette.backgroundColor)')

    const out = resolveTidePalette(LIGHT_BASE, { waterColor: '#00A1fF', crestColor: '#abcabc' }, 0.8)
    expect(out.backgroundColor).toBe('#f8fafc')
    expect(out.waterColor).toBe('#00A1fF')
    expect(out.crestColor).toBe('#abcabc')
    expect(out.waveHeight).toBe(0.8)
    // 其余旋钮一律不动
    expect(out.opacity).toBe(LIGHT_BASE.opacity)
    expect(out.density).toBe(LIGHT_BASE.density)
    expect(out.particleSize).toBe(LIGHT_BASE.particleSize)
  })

  it('浅色 / 深色各用各的自定义色（Q-3）', () => {
    const light = resolveTidePalette(LIGHT_BASE, { waterColor: '#111111', crestColor: null }, 0.65)
    const dark = resolveTidePalette(DARK_BASE, { waterColor: null, crestColor: '#222222' }, 0.65)
    expect(light.waterColor).toBe('#111111')
    expect(light.crestColor).toBe(LIGHT_BASE.crestColor)
    expect(dark.waterColor).toBe(DARK_BASE.waterColor)
    expect(dark.crestColor).toBe('#222222')
    expect(light.backgroundColor).toBe('#f8fafc')
    expect(dark.backgroundColor).toBe('#111113')
  })

  it('非法 / 缺失值逐片回落 + 浪高 clamp（Q-4 边界）', () => {
    expect(
      resolveTidePalette(LIGHT_BASE, { waterColor: '#abc', crestColor: '#gggggg' }, Number.NaN)
    ).toMatchObject({
      waterColor: LIGHT_BASE.waterColor,
      crestColor: LIGHT_BASE.crestColor,
      waveHeight: 0.65
    })
    expect(resolveTidePalette(DARK_BASE, undefined, 10).waveHeight).toBe(1.5)
    expect(resolveTidePalette(DARK_BASE, undefined, -3).waveHeight).toBe(0.2)
    expect(resolveTidePalette(DARK_BASE, { waterColor: '#00A1fF', crestColor: null }, 0.65).waterColor).toBe('#00A1fF')
  })
})

describe('T2 · 设置页首页卡控件守卫', () => {
  it('色板 + HEX 同字段双向绑定，浅深各一份（Q-2/Q-3）', () => {
    expect(HOME_CARD).toContain('type="color"')
    expect(HOME_CARD).toContain('validHexOrNull(')
    expect(HOME_CARD).toContain('hexDrafts[key] ?? current ??')
    expect(HOME_CARD).toContain("commitWaveColor(theme, slot, e.target.value)")
    expect(HOME_CARD).toContain("(['light', 'dark'] as const)")
    expect(HOME_CARD).toContain('WAVE_FALLBACK_HEX[theme][slot]')
    // 重置写 null = 回落 palette，而不是写一个假颜色
    expect(HOME_CARD).toContain('commitWaveColor(theme, slot, null)')
  })

  it('浪高单滑块 clamp、背景图本地 + URL（Q-4/Q-5；压暗滑块 2026-11-22 已移除）', () => {
    // 2026-11-23：高度行并入 WaveSliderRow（松手提交，修「拖动巨卡不跟手」）——
    // 范围值经 range 字面量传入，clamp 语义保留在提交回调 clampWaveHeight(v)
    expect(HOME_CARD).toContain('<WaveSliderRow')
    expect(HOME_CARD).toContain('clampWaveHeight(v)')
    expect(HOME_CARD).toContain('min: 0.2')
    expect(HOME_CARD).toContain('max: 1.5')
    expect(HOME_CARD).toContain('step: 0.05')
    expect(HOME_CARD).toContain("['local', '本地文件']")
    expect(HOME_CARD).toContain("['url', '图片 URL']")
    // 卡片里接按钮，构造入参在组件顶部的 helper（同时守卫两处，防只接一半）
    expect(HOME_CARD).toContain('void pickLocalBackground()')
    expect(SETTINGS_CODE).toContain("{ kind: 'local', filePath }")
    expect(HOME_CARD).toContain("{ kind: 'url', url }")
    // 2026-11-22 用户拍板压暗整体移除：滑块与其写入入口都不许回来
    // （dimAlpha 字段保留只为旧档 schema 兼容，渲染层不再读取）
    expect(HOME_CARD).not.toContain('clampDimAlpha')
    expect(HOME_CARD).not.toContain('dimAlpha')
    // 失败不写坏 fileName：helper 里只在 result.ok 之后 saveSettings
    expect(SETTINGS_CODE).toContain('if (!result.ok)')
    // 预设色板不含 D5A 紫
    expect(HOME_CARD).not.toMatch(/--d5-brand|#[0-9a-f]*8a2be2/i)
  })
})

describe('T2 · 渲染层接线守卫', () => {
  it('observer 按主题取色 + 标量快照短路 + 依赖数组含 waveColors/waveHeight', () => {
    expect(PARTICLES_CODE).toContain(
      'resolveTidePalette(PALETTES[theme], customFor(theme), waveHeight)'
    )
    expect(PARTICLES_CODE).toContain(
      'if (signatureOf(theme, next) === signatureOf(paletteKey, palette)) return'
    )
    // 依赖数组必须吃全六个用户参数（2026-11-22 海浪参数重排扩容）
    expect(PARTICLES_CODE).toMatch(
      /\}, \[\s*quality,\s*waveColors,\s*waveHeight,\s*transparentBackground,\s*waveSpeed,\s*waveLength,\s*particleSize,\s*particleDensity,\s*waveInteractive,\s*waveClickRipples\s*\]\)/
    )
    // T1 约定的 HEX_PATTERN 顶部 import + :274 re-export 一个都不能丢
    expect(PARTICLES).toContain("import { HEX_PATTERN } from '../../../shared/homeTide'")
    expect(PARTICLES).toContain("export { HEX_PATTERN } from '../../../shared/homeTide'")
  })

  it('壁纸层上移 App 根部 fixed 全屏 / 压暗层已删除 / 粒子透明底（2026-11-22）', () => {
    const app = readSrc('src/renderer/App.tsx')
    const appCode = stripComments(app)
    // 压暗层整体移除：HomeCover 源码（含注释）不允许再出现纯黑 rgba / dimAlpha 消费
    expect(COVER).not.toMatch(/rgba\(0,0,0|dimAlpha/)
    // 图片层不再是 HomeCover 的 z-[1] 内层（连同 z-[2] 压暗层一起删掉），
    // 而是上移到 App 根部：fixed inset-0 铺满全窗口（含顶栏）。层级用 z-0 ——
    // 负 z-index 的 fixed 层在 Electron 合成器里会被画布背景盖住（2026-11-23 真机
    // CDP 红色实验实锤），z-0 + 三列容器补 relative（DOM 靠后的 z-auto 定位）才正确。
    expect(COVER_CODE).not.toContain('z-[1]')
    expect(COVER_CODE).not.toContain('z-[2]')
    expect(appCode).toContain('pointer-events-none fixed inset-0 z-0')
    expect(appCode).toContain('relative flex min-h-0 flex-1')
    expect(appCode).toContain('url(bg://${encodeURIComponent(stableHomeBackground.fileName)})')
    expect(appCode).toContain("stableHomeBackground.source !== 'none'")
    // 2026-11-23 用户口径：壁纸与海浪**互斥** —— 挂壁纸时粒子层整体不渲染
    //（hasWallpaper 条件），transparentBackground 不再从 HomeCover 传参（引擎能力保留）。
    expect(COVER_CODE).toContain('const hasWallpaper =')
    expect(COVER_CODE).toContain('{!hasWallpaper ? (')
    expect(COVER_CODE).not.toContain('transparentBackground=')
    expect(PARTICLES_CODE).toContain('transparentBackground')
    // 粒子引擎真源：TideSettings 有透明底开关 + GL/2D 两条路径都吃它
    const tide = stripComments(readSrc('src/renderer/components/home/particleTide.ts'))
    expect(tide).toContain('transparentBackground?: boolean')
    // 透明模式 rgb 必须一并清零（预乘不变式：a=0 ⇔ rgb=0，否则 Chromium 合成漏白雾盖壁纸）
    expect(tide).toContain('gl.clearColor(0, 0, 0, 0)')
    expect(tide).toContain('gl.clearColor(background[0], background[1], background[2], 1)')
    expect(tide).toContain('if (!s.transparentBackground)')
    // 原始文本（含注释）都不出现这三种禁用模式（守卫范围只保留 HomeCover.tsx；
    // Toolbar 的 backdrop-filter 是 2026-11-22 用户点名的唯一豁免，见下一条守卫）
    expect(COVER).not.toMatch(/gradient|backdrop-filter|filter:/)
  })

  it('顶栏毛玻璃只在首页态启用（2026-11-22），普通视图保持不透明', () => {
    const toolbar = readSrc('src/renderer/components/Toolbar.tsx')
    const toolbarCode = stripComments(toolbar)
    // 毛玻璃样式以 homeMode 为条件的单一真源
    expect(toolbarCode).toContain('const glassStyle: CSSProperties | undefined = homeMode')
    expect(toolbarCode).toContain("backdropFilter: 'blur(14px)'")
    // 2026-11-23 用户口径：顶栏只要高斯模糊、**不要白底** —— background 必须是
    // transparent，不得再出现 color-mix(--bg-canvas) 之类的半透明白底
    expect(toolbarCode).toContain("background: 'transparent'")
    expect(toolbarCode).not.toContain('color-mix')
    // 确实挂到了 header 上
    expect(toolbarCode).toContain('style={glassStyle}')
  })

  it('海浪参数重排：四区块 UI + 引擎接线（2026-11-22）', () => {
    // 设置页四区块锚点：预设下拉 / 滑块区标题 / 两个折叠区标题 / 背景区块仍在
    expect(HOME_CARD).toContain('aria-haspopup="listbox"')
    // 两档选项字面量在模块级 WAVE_PRESET_OPTIONS（卡片切片里只有浮层接线）
    expect(SETTINGS_CODE).toContain("label: '跟随主题默认'")
    expect(SETTINGS_CODE).toContain("label: '自定义'")
    // 2026-11-23：滑块区也改折叠（用户口径「滑块不需要长显示」），三折叠区同一套 WaveCollapseRow
    expect(HOME_CARD).toContain('title="海浪参数"')
    expect(HOME_CARD).toContain('title="海浪形态与交互"')
    expect(HOME_CARD).toContain('title="自定义配色"')
    expect(HOME_CARD).toContain('title="首页背景图"')
    // 预设下拉是**自绘浮层**（照 App.tsx 排序胶囊范式），不许退回原生 <select>
    //（zhimoSettings.test.ts 红线：整份设置页零原生 <select>）
    expect(HOME_CARD).toContain('role="option"')
    expect(HOME_CARD).toContain('WAVE_PRESET_OPTIONS')
    expect(HOME_CARD).toContain('togglePresetPanel')
    expect(SETTINGS_CODE).not.toMatch(/<select\b/)
    expect(SETTINGS_CODE).toContain("window.addEventListener('mousedown', onPointerDown)")
    // Esc 归层栈（T-ESC 裁定）：浮层用 useEscLayer 压栈成弹窗内第二层，
    // 不许自挂 keydown（modalEsc.test.ts 红线：SettingsDialog 零 keydown 监听）
    expect(SETTINGS_CODE).toContain('useEscLayer(() => setPresetPanel(false), presetPanel)')
    // 折叠交互不引第三方：标题行 + −/+（WaveCollapseRow 是模块级组件，锚点在整份源码）
    expect(SETTINGS_CODE).toContain("open ? '−' : '+'")
    // 四个滑块 + 两个开关全部接到 settings 真源
    expect(HOME_CARD).toContain('homeWaveSpeed:')
    expect(HOME_CARD).toContain('homeParticleSize:')
    expect(HOME_CARD).toContain('homeParticleDensity:')
    expect(HOME_CARD).toContain('homeWaveLength:')
    expect(HOME_CARD).toContain('homeWaveInteractive:')
    expect(HOME_CARD).toContain('homeWaveClickRipples:')
    // 数值规格只从 shared 的 HomeTideRange 常量取（不在 UI 手抄 min/max/step）
    expect(HOME_CARD).toContain('range={HOME_WAVE_SPEED_RANGE}')
    expect(HOME_CARD).toContain('range={HOME_PARTICLE_SIZE_RANGE}')
    expect(HOME_CARD).toContain('range={HOME_PARTICLE_DENSITY_RANGE}')
    expect(HOME_CARD).toContain('range={HOME_WAVE_LENGTH_RANGE}')
    // HomeParticles 直接读 store（HomeCover 本批禁碰），六项全接
    expect(PARTICLES_CODE).toContain("s.settings?.homeWaveSpeed ?? DEFAULT_SETTINGS.homeWaveSpeed")
    expect(PARTICLES_CODE).toContain("s.settings?.homeWaveLength ?? DEFAULT_SETTINGS.homeWaveLength")
    expect(PARTICLES_CODE).toContain('s.settings?.homeParticleSize ?? DEFAULT_SETTINGS.homeParticleSize')
    expect(PARTICLES_CODE).toContain('s.settings?.homeParticleDensity ?? DEFAULT_SETTINGS.homeParticleDensity')
    expect(PARTICLES_CODE).toContain('s.settings?.homeWaveInteractive !== false')
    expect(PARTICLES_CODE).toContain('s.settings?.homeWaveClickRipples !== false')
    // 引擎接线：用户开关与 palette 总闸求与；速度/波长/大小/密度走 params 不再硬编码
    expect(PARTICLES_CODE).toContain('interactive: params.interactive && palette.interactive')
    expect(PARTICLES_CODE).toContain('clickRipples: params.clickRipples && palette.clickRipples')
    expect(PARTICLES_CODE).toContain('particleSize: params.particleSize')
    expect(PARTICLES_CODE).toContain('wavelength: params.wavelength')
    expect(PARTICLES_CODE).toContain('speed: params.speed')
    // 引擎定稿值不再以本地常量残留（默认值唯一真源 = shared 的 RANGE.default）
    expect(PARTICLES_CODE).not.toContain('BASE_SPEED')
    expect(PARTICLES_CODE).not.toContain('BASE_WAVELENGTH')
    // settings.ts 三处齐全：schema catch + migrate clamp + normalize clamp
    const settingsSrc = stripComments(readSrc('src/main/settings.ts'))
    expect(settingsSrc).toContain('homeWaveSpeed: z.number().optional().catch(HOME_WAVE_SPEED_RANGE.default)')
    expect(settingsSrc).toContain('homeWaveLength: z.number().optional().catch(HOME_WAVE_LENGTH_RANGE.default)')
    expect(settingsSrc).toContain('homeParticleSize: z.number().optional().catch(HOME_PARTICLE_SIZE_RANGE.default)')
    expect(settingsSrc).toContain('homeParticleDensity: z.number().optional().catch(HOME_PARTICLE_DENSITY_RANGE.default)')
    expect(settingsSrc).toContain('homeWaveInteractive: z.boolean().optional().catch(true)')
    expect(settingsSrc).toContain('homeWaveClickRipples: z.boolean().optional().catch(true)')
    expect(settingsSrc).toContain('clampHomeTideNumber(raw.homeWaveSpeed, HOME_WAVE_SPEED_RANGE)')
    expect(settingsSrc).toContain('clampHomeTideNumber(merged.homeWaveSpeed, HOME_WAVE_SPEED_RANGE)')
    // shared 区间常量与 clamp 是单一真源
    const typesSrc = readSrc('src/shared/types.ts')
    expect(typesSrc).toContain('export const HOME_WAVE_SPEED_RANGE: HomeTideRange')
    expect(typesSrc).toContain('export function clampHomeTideNumber(')
  })

  it('为 T4 预留 data-guide 锚点（只加属性不改布局）', () => {
    expect(COVER_CODE).toContain('data-guide="search"')
    expect(COVER_CODE).toContain('data-guide="folders"')
    expect(COVER_CODE).toContain('data-guide="settings"')
  })

  it('App 侧 useMemo 稳定 waveColors / homeBackground 引用（R-15）', () => {
    const app = stripComments(readSrc('src/renderer/App.tsx'))
    expect(app).toMatch(
      /useMemo\(\s*\(\) => homeWaveColors \?\? DEFAULT_SETTINGS\.homeWaveColors/
    )
    expect(app).toMatch(
      /useMemo\(\s*\(\) => homeBackground \?\? DEFAULT_SETTINGS\.homeBackground/
    )
    expect(app).toContain('waveColors={stableHomeWaveColors}')
    expect(app).toContain('waveHeight={safeHomeWaveHeight}')
    expect(app).toContain('homeBackground={stableHomeBackground}')
  })
})

describe('T2 · bg:// scheme 与 IPC 四处同步守卫', () => {
  it('protocol.ts 注册 / VaultDirs / handle / serveStatic 四处齐 + 越界检查在', () => {
    const protocol = stripComments(readSrc('src/main/protocol.ts'))
    expect(protocol).toContain("scheme: 'bg'")
    expect(protocol).toContain("protocol.handle('bg'")
    expect(protocol).toContain('bgDir: string')
    expect(protocol).toContain('dirs.bgDir')
    expect(protocol).toContain("scheme: 'vault' | 'hdr' | 'bg'")
    expect(protocol).toContain('isWithinRoot(root, abs, path.sep)')
  })

  it('两条 IPC 三处真源同步 + bgDir 注入', () => {
    const ipc = stripComments(readSrc('src/shared/ipc.ts'))
    expect(ipc).toContain("homeBackgroundSave: 'homeBackground:save'")
    expect(ipc).toContain("homeBackgroundClear: 'homeBackground:clear'")
    const preload = stripComments(readSrc('src/preload/index.ts'))
    expect(preload).toContain('saveHomeBackground: (input: HomeBackgroundSaveInput)')
    expect(preload).toContain('clearHomeBackground: (fileName: string | null)')
    const main = stripComments(readSrc('src/main/index.ts'))
    expect(main).toContain('ipcMain.handle(IPC.homeBackgroundSave')
    expect(main).toContain('ipcMain.handle(IPC.homeBackgroundClear')
    expect(main).toContain('bgDir: backgroundCacheDir()')
  })

  it('主进程缓存模块只存文件名 + 越界守卫 + 大小上限', () => {
    // 本文件不用 stripComments：源码里 `Accept: 'image/*'` 的字符串含 `/*`，
    // 朴素剥注释正则会把它误当块注释起点，把后半段代码一并吃掉。
    const bg = readSrc('src/main/homeBackground.ts')
    expect(bg).toContain("CACHE_DIR_NAME = 'home-bg'")
    expect(bg).toContain('MAX_IMAGE_BYTES = 20 * 1024 * 1024')
    expect(bg).toContain("net.fetch(parsed.href")
    expect(bg).toContain("mainType.startsWith('image/')")
    expect(bg).toContain("parsed.protocol !== 'http:' && parsed.protocol !== 'https:'")
    expect(bg).toContain('path.basename(fileName) !== fileName')
    expect(bg).toContain('createHash(\'sha256\')')
  })
})
