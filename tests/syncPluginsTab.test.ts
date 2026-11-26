/**
 * 同步插件 tab（2026-11-22 用户拍板重构）源码守卫。
 *
 * ## 为什么主要是源码守卫
 * `vitest.config.ts` 是 `environment: 'node'`，全仓无 jsdom / RTL。本任务只改
 * `SettingsDialog.tsx` 的内容区、`icons.tsx` 的三个图标，没有新增 `src/shared/`
 * 纯函数模块，因此按 `tests/homeCustomWiring.test.ts` 同款范式：读文件文本 +
 * 断言接线点（不发请求、不渲染 DOM）。
 *
 * ## 每条守卫防的具体退化
 * | # | 守卫 | 防的退化 |
 * |---|---|---|
 * | 1 | 四处真源 + useState 类型 | tab 真源被误删 ⇒ 白屏 / 页头 undefined |
 * | 2 | 恰好三卡（SketchUp / Rhino / 3DS MAX）+ disabled 两真 + 卡片常量为零版本号 | 卡回流 / 灰错对象 / 编造版本号回流 |
 * | 3 | 四态右侧控件（安装 / 已安装 / 更新到 X）+ onClick 真调 exportRbz + 待开发灰卡 | 已安装态不可点导致无法升级（1.0.x 的 bug） |
 * | 4 | 说明态（onExplain / syncPluginExplainText / explainedCard）零命中 | 说明态复活 |
 * | 5 | 数据 tab rbz 行删除、D-2 行仍在 | 功能重复提供 / 开关行被误搬 |
 * | 6 | 绿点判据 = install.state（真机扫描），不再是 connected（自证） | "自己写过索引"冒充已安装 |
 * | 7 | syncPlugins 区块零网络、无紫色 / 无 hex / 图标 currentColor | 红线约束回退 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 相对仓库根读源码；换行归一（工作区 CRLF，跨行断言不能被换行符干扰）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 取两个标记之间的源码片段；标记找不到就红，避免"切片为空 ⇒ 断言全过"。 */
function between(src: string, startMark: string, endMark: string): string {
  const start = src.indexOf(startMark)
  expect(start, `找不到起始标记：${startMark}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf(endMark, start + startMark.length)
  expect(end, `找不到结束标记：${endMark}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

const SETTINGS_SRC = readSrc('src/renderer/components/SettingsDialog.tsx')
const ICONS_SRC = readSrc('src/renderer/icons.tsx')

const SETTINGS_TAB_BLOCK = between(SETTINGS_SRC, 'type SettingsTab =', 'const TABS:')
const TABS_BLOCK = between(SETTINGS_SRC, 'const TABS:', 'const TAB_GROUPS:')
const TAB_GROUPS_BLOCK = between(
  SETTINGS_SRC,
  'const TAB_GROUPS:',
  '/** 页头副标题（设计稿逐屏文案'
)
const TAB_SUB_BLOCK = between(SETTINGS_SRC, 'const TAB_SUB:', 'type SyncPluginCard = {')
const CARDS_BLOCK = between(
  SETTINGS_SRC,
  'const SYNC_PLUGIN_CARDS:',
  '/**\n * 反馈卡里的 GitHub Issue 入口。'
)
/** 内容区**逐字边界**：起于 `syncPluginsTab` 定义，止于下一个 tab 之外的注释。 */
const SYNC_BLOCK = between(
  SETTINGS_SRC,
  'const syncPluginsTab = (',
  '// 强制重扫弹窗里的数字'
)

type ParsedCard = {
  name: string
  supportText: string
  icon: string
  disabled: boolean
}

/**
 * 卡片常量的纯解析：只认逐字段写法，字段顺序或名字漂移都会让条数不足而红。
 *
 * 2026-11-23 起卡片常量**没有 version 字段**（三个写死的版本号全是过期或编造的，
 * 真实版本一律由主进程扫真机得出）。
 */
function parseCards(src: string): ParsedCard[] {
  const re =
    /name: '([^']+)',\s*supportText: '([^']+)',\s*icon: (\w+),\s*disabled: (true|false)/g
  return Array.from(src.matchAll(re), (m) => ({
    name: m[1],
    supportText: m[2],
    icon: m[3],
    disabled: m[4] === 'true'
  }))
}

describe('tab 真源（S-8）', () => {
  it('SettingsTab / TABS / TAB_GROUPS / TAB_SUB 都含 syncPlugins', () => {
    expect(SETTINGS_TAB_BLOCK).toContain("| 'syncPlugins'")
    expect(TABS_BLOCK).toContain("{ key: 'syncPlugins', label: '同步插件' }")
    expect(TAB_GROUPS_BLOCK).toContain("{ label: '扩展', keys: ['syncPlugins'] }")
    expect(TAB_SUB_BLOCK).toContain("syncPlugins: 'Rhino、SketchUp、3ds Max 插件同步入口'")
  })

  it('useState 类型扩展但初值仍是 appearance', () => {
    expect(SETTINGS_SRC).toContain("useState<SettingsTab>('appearance')")
  })

  it('内容switch 真正渲染新 tab', () => {
    expect(SETTINGS_SRC).toContain("{tab === 'syncPlugins' && syncPluginsTab}")
  })

  it('其余 7 个 tab 的 label / 副标题逐字不变', () => {
    const labels: Array<[string, string]> = [
      ['appearance', '外观'],
      ['import', '导入'],
      ['classify', '分类'],
      ['library', '库'],
      ['alias', '别名'],
      ['data', '数据与备份'],
      ['about', '关于']
    ]
    for (const [key, label] of labels) {
      expect(TABS_BLOCK, `label: ${label}`).toContain(`{ key: '${key}', label: '${label}' }`)
    }
    const subs: Array<[string, string]> = [
      // appearance 副标题于 2026-11 追加「窗口与后台」卡后同步更新（原为「主题、动效、侧栏显示」）
      ['appearance', '主题、动效、侧栏、窗口与后台'],
      ['import', '压缩包、解压、命名、来源与封面'],
      ['classify', '导入后怎么归类，以及存量怎么重排'],
      ['library', '库目录、索引维护、结构迁移'],
      ['alias', '把口语 / 英文词映射到分类'],
      ['data', '删除、缓存、日志与迁移'],
      ['about', '版本、更新与反馈']
    ]
    for (const [key, sub] of subs) {
      expect(TAB_SUB_BLOCK, `sub: ${key}`).toContain(`${key}: '${sub}'`)
    }
  })

  it('「扩展」独立成组，只含 syncPlugins，且落在「数据」与「其他」之间', () => {
    const groups = Array.from(
      TAB_GROUPS_BLOCK.matchAll(/\{ label: '([^']+)', keys: \[([^\]]*)\] \}/g),
      (m) => ({ label: m[1], keys: m[2] })
    )
    expect(groups.map((g) => g.label)).toEqual(['偏好', '素材', '数据', '扩展', '其他'])
    const extension = groups.find((g) => g.label === '扩展')
    expect(extension?.keys.replace(/\s/g, '')).toBe("'syncPlugins'")
    const labels = groups.map((g) => g.label)
    expect(labels.indexOf('扩展')).toBeGreaterThan(labels.indexOf('数据'))
    expect(labels.indexOf('扩展')).toBeLessThan(labels.indexOf('其他'))
  })
})

describe('三张卡与按钮文案（2026-11-22 / 11-23 拍板）', () => {
  const cards = parseCards(CARDS_BLOCK)

  it('恰好 3 张卡，SketchUp 排第一：SketchUp / Rhino / 3DS MAX（被删的四张不回流）', () => {
    expect(cards.map((c) => c.name)).toEqual(['SketchUp', 'Rhino', '3DS MAX'])
    for (const gone of ['Cinema 4D', 'ARCHICAD', 'Blender', 'Revit', 'SketchUp LiveSync']) {
      expect(CARDS_BLOCK, `${gone} 应已删除`).not.toContain(`name: '${gone}'`)
    }
  })

  it('卡片常量里没有版本号（2026-11-23：三个写死版本全是过期或编造）', () => {
    expect(CARDS_BLOCK).not.toContain('version:')
    expect(SETTINGS_SRC).not.toContain('0.8.0')
    expect(SYNC_BLOCK).not.toContain('card.version')
    // 真实版本只来自主进程扫描结果
    expect(SYNC_BLOCK).toContain('install.shippedVersion')
  })

  it('每张都有四个字段，supportText 走「支持 xx 版本」展示形态', () => {
    for (const card of cards) {
      expect(card.supportText.startsWith('支持 '), card.name).toBe(true)
      expect(card.supportText.includes('版本'), card.name).toBe(true)
      expect(card.icon.length, card.name).toBeGreaterThan(0)
    }
  })

  it('Rhino / 3DS MAX 是灰卡（待开发），SketchUp 可点（Q-8 口径延续）', () => {
    expect(cards.filter((c) => c.disabled).map((c) => c.name)).toEqual(['Rhino', '3DS MAX'])
  })

  it('三个图标都是 icons.tsx 内联 SVG（零外链），被裁图标无残留', () => {
    for (const card of cards) {
      expect(ICONS_SRC, `export ${card.icon}`).toContain(`export const ${card.icon} = (p: P) => (`)
    }
    expect(ICONS_SRC).toContain('stroke="currentColor"')
    expect(CARDS_BLOCK).not.toMatch(/https?:|\.(png|svg|jpg|webp)['"]/)
    for (const gone of ['IconCinema4d', 'IconArchicad', 'IconBlender', 'IconRevit', 'IconSketchUpLiveSync']) {
      expect(ICONS_SRC, `${gone} 应已删除`).not.toContain(`export const ${gone}`)
      expect(SETTINGS_SRC, `SettingsDialog 不再引用 ${gone}`).not.toContain(gone)
    }
  })

  it('SketchUp 卡「安装插件」是真功能：onClick 调 exportRbz、忙碌态置 disabled', () => {
    expect(SYNC_BLOCK).toContain('安装插件')
    expect(SYNC_BLOCK).toContain('onClick={() => void exportRbz()}')
    expect(SYNC_BLOCK).toContain('disabled={rbzExporting}')
    expect(SYNC_BLOCK).toContain('打包中…')
  })

  it('四态右侧控件：missing 给「安装插件」、outdated 给「更新到 X」、installed/ahead 给灰胶囊', () => {
    // missing / 旧主进程（无 install）：安装按钮，行为不变
    expect(SYNC_BLOCK).toContain('安装插件')
    expect(SYNC_BLOCK).toContain('!install || install.state === ')
    // outdated：主按钮真调 exportRbz，文案带本体自带版本
    expect(SYNC_BLOCK).toContain("install.state === 'outdated'")
    expect(SYNC_BLOCK).toContain('`更新到 ${install.shippedVersion}`')
    expect(SYNC_BLOCK).toContain('onClick={() => void exportRbz()}')
    expect(SYNC_BLOCK).toContain('disabled={rbzExporting}')
    expect(SYNC_BLOCK).toContain('打包中…')
    // installed / ahead：成功色胶囊，文案带真机版本
    expect(SYNC_BLOCK).toContain('`已安装 v${install.installedVersion}`')
    expect(SYNC_BLOCK).toContain('bg-success/15')
    // 更新按钮的 title 说清"装的是哪个版本 + 怎么覆盖安装"
    expect(SYNC_BLOCK).toContain('导出后在 SketchUp 里用扩展管理器覆盖安装')
  })

  it('已安装 / 领先两态是 span 胶囊、不可点（不挂 onClick）', () => {
    const start = SYNC_BLOCK.indexOf('/* installed / ahead')
    expect(start).toBeGreaterThanOrEqual(0)
    const pill = SYNC_BLOCK.slice(start, start + 700)
    expect(pill).toContain('bg-success/15')
    expect(pill).not.toContain('onClick=')
    expect(pill).not.toContain('<button')
  })

  it('第二行摘要逐台列版本（2026-11-23：单台「已装 vX」/ 双台逐台列 / 三台带「等 n 个」）', () => {
    const helper = between(SETTINGS_SRC, 'function sketchupInstallText(', '\n}')
    // 单台：带「已装」
    expect(helper).toContain('hits.length === 1')
    expect(helper).toContain('`${only.sketchup} 已装 v${only.version}`')
    expect(helper).toContain('`${only.sketchup} 已装`')
    // 双台：逐台列「SketchUp 2025 v1.1.0 · SketchUp 2024 v1.0.5」
    expect(helper).toContain('.slice(0, 2)')
    expect(helper).toContain('`${hit.sketchup} v${hit.version}`')
    expect(helper).toContain(".join(' · ')")
    // 三台及以上：补「等 n 个」（n = 总台数）
    expect(helper).toContain('`${head} · 等 ${hits.length} 个`')
    // 顺序沿用 install.hits（已降序），helper 内不得再排序
    expect(helper).not.toContain('.sort(')
    expect(SYNC_BLOCK).toContain('sketchupInstallText(install) ?? card.supportText')
  })

  it('旧口径「n 个 SketchUp 已装 vX」不得回流（会把旧版糊掉）', () => {
    expect(SETTINGS_SRC).not.toContain('个 SketchUp 已装')
    expect(SETTINGS_SRC).not.toContain('versionText')
  })

  it('灰卡写「待开发」且按钮 disabled；「后续开发」「下载插件」等旧文案 0 命中', () => {
    expect(SYNC_BLOCK).toContain('待开发')
    expect(SYNC_BLOCK).toMatch(/type="button"\s*\n\s*disabled/)
    for (const bad of ['后续开发', '下载插件', '排期开发', '个文件', '快速上手', '视频卡']) {
      expect(SYNC_BLOCK, `禁止文案：${bad}`).not.toContain(bad)
    }
    expect(SYNC_BLOCK).not.toMatch(/Render|Lite/)
  })

  it('三张卡单列布局（双列会剩一个空位）', () => {
    expect(SYNC_BLOCK).toContain('grid grid-cols-1')
    expect(SYNC_BLOCK).not.toContain('grid-cols-2')
  })
})

describe('说明态已整体删除', () => {
  it('onExplain / syncPluginExplainText / explainedCard 全部 0 命中', () => {
    expect(SETTINGS_SRC).not.toContain('onExplain')
    expect(SETTINGS_SRC).not.toContain('syncPluginExplainText')
    expect(SETTINGS_SRC).not.toContain('explainedCard')
    expect(SYNC_BLOCK).not.toContain('插件安装说明')
  })

  it('说明态不写 D-2 的两个引导位（S-2，删除后仍不得回流）', () => {
    expect(SYNC_BLOCK).not.toContain('pluginIndexEnabled')
    expect(SYNC_BLOCK).not.toContain('pluginIndexGuideShown')
  })
})

describe('绿点判据 = 真机扫描（2026-11-23 修复：不再用 connected 自证）', () => {
  it('SketchUp 卡名称后方有 success token 绿点（不自造 hex）', () => {
    expect(SYNC_BLOCK).toContain("card.name === 'SketchUp'")
    expect(SYNC_BLOCK).toContain("install !== undefined && install.state !== 'missing'")
    expect(SYNC_BLOCK).toContain('rounded-full bg-success')
    expect(SYNC_BLOCK).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('绿点不再由 connected 驱动（旧判据是"本体自己写过索引"，自证）', () => {
    expect(SYNC_BLOCK).not.toContain('pluginLink.connected')
    expect(SYNC_BLOCK).not.toContain('已检测到插件连接')
  })

  it('绿点 / 胶囊 title 说真话：已安装于哪个 SketchUp', () => {
    expect(SYNC_BLOCK).toContain('`已安装于 ${bestHit?.sketchup ?? ')
  })

  it('切到 syncPlugins tab 时经 IPC 刷新一次（getPluginLinkStatus 接线）', () => {
    // 调用点在源码里是跨行链式写法，按片段断言
    expect(SETTINGS_SRC).toContain('.getPluginLinkStatus()')
    expect(SETTINGS_SRC).toContain('.then(setPluginLink)')
    expect(SETTINGS_SRC).toContain('.catch(() => setPluginLink({ connected: false, generatedAt: null }))')
    // 只在同步插件 tab 查询（tab 进依赖数组：每次切进来都刷新）
    expect(SETTINGS_SRC).toContain("if (tab !== 'syncPlugins') return")
    const effectBlock = between(SETTINGS_SRC, 'if (tab !== \'syncPlugins\') return', '}, [tab])')
    expect(effectBlock).toContain('.getPluginLinkStatus()')
  })

  it('IPC 三处真源齐全（shared 通道 / preload 桥 / main handler）', () => {
    expect(readSrc('src/shared/ipc.ts')).toContain("pluginLinkStatus: 'plugin:linkStatus'")
    expect(readSrc('src/preload/index.ts')).toContain('getPluginLinkStatus')
    expect(readSrc('src/main/index.ts')).toContain('IPC.pluginLinkStatus')
    // main 判据抽成纯函数（pluginLink.ts），handler 只做读盘与收敛
    expect(readSrc('src/main/index.ts')).toContain('parsePluginLinkStatus')
  })
})

describe('数据 tab 的 rbz 行已搬走，D-2 开关行不动（S-2）', () => {
  it('「导出 SketchUp 插件包（.rbz）」行与结果块整体删除，无重复功能', () => {
    // 数据 tab 旧行的 title 以引号收尾（同步 tab 新按钮的 title 后面还接着引导语，
    // 不能用裸字符串判，否则会误伤新按钮）
    expect(SETTINGS_SRC).not.toContain('title="导出 SketchUp 插件包（.rbz）"')
    expect(SETTINGS_SRC).not.toContain("'导出 .rbz'")
    expect(SETTINGS_SRC).not.toContain('rbzExport &&')
    expect(SETTINGS_SRC).not.toContain('插件包已导出</span>')
  })

  it('D-2 三处原有字符串逐字仍在（不被搬动/改写）', () => {
    expect(SETTINGS_SRC).toContain('const showPluginIndexGuide =')
    expect(SETTINGS_SRC).toContain(
      'settings?.pluginIndexGuideShown !== true && settings?.pluginIndexEnabled !== true'
    )
    expect(SETTINGS_SRC).toContain(
      '插件读的是 ID BOX 导出的一份素材清单，只在确有变化时刷新；文件就放在'
    )
    expect(SETTINGS_SRC).toContain('title="SketchUp 插件"')
    expect(SETTINGS_SRC).toContain(
      'desc="为 SketchUp 插件持续导出索引快照（只读）。"'
    )
  })
})

describe('零网络 / 配色（Q-10 / S-7）', () => {
  it('syncPlugins 内容区源码零网络调用', () => {
    expect(SYNC_BLOCK).not.toMatch(/fetch\(|http|net\.|openExternal|shell/)
  })

  it('新代码不碰紫色例外与硬编码颜色，图标继承 currentColor', () => {
    expect(SYNC_BLOCK).not.toContain('--d5-brand')
    expect(SYNC_BLOCK).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(SYNC_BLOCK).toContain('text-accent')
    expect(SYNC_BLOCK).toContain('grayscale')
  })
})
