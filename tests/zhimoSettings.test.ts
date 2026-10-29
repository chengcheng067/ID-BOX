/// <reference lib="dom" />
/**
 * 「按站方分类自动落库」设置项 + 设置页手动入口（0.7.x）验收。
 *
 * 本仓库的渲染层单测跑在 `environment: 'node'`（**没有 jsdom**），所以 UI 只能做
 * **源码守卫**：把"必须存在的接线"和"必须不存在的控件"钉成断言。分四块：
 * ① 设置项 `zhimoAutoCategory` 的默认值 / 归一化（缺键、脏值一律按开；`libraryDir` 不许丢）；
 * ② 设置页**真的**接了开关、手动入口、进度/取消、撤销（函数名逐字出现）；
 * ③ 新加的控件**没有**原生 `checkbox` / `<select`（用户 2026-10 拍板要自绘控件）；
 * ④ `store.undoLastReclassify` 的**可选前缀参数**（缺省 `'reclass-'`，老调用点一字未改）——
 *    这是两条通道互不消费对方备份的前提。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { migrateSettings, normalizeSettings, SettingsSchema } from '../src/main/settings'

const read = (rel: string): string =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/** 去掉块注释与行注释：守卫只针对真实代码（注释里提 checkbox / prefix 不算接线） */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * 切出「存量重排」那张卡（含按站方分类重排的控件集）。
 *
 * 边界用组件里的**显式守卫标记**（`@guard:zhimo-reclass` … `-end`）：
 * - v0.8.1 设置页重排把 `SectionTitle` 换成了 `SettingsCard.title`，原来的文字锚点失效；
 * - v0.8.1b 又把「可撤销备份 N 份」从行右侧挪进**卡底 note**，所以标记上移到卡片开头
 *   （note 是 `<SettingsCard>` 的属性、在源码里位于 children 之前）。
 * 标记只用于切段、不参与渲染；检查项一字未改。
 */
function zhimoSectionSource(): string {
  const src = read('renderer/components/SettingsDialog.tsx')
  // 标记字面量里刻意不含注释结束符，避免本文件自己的块注释被提前闭合
  const start = src.indexOf('@guard:zhimo-reclass ')
  if (start < 0) return ''
  const end = src.indexOf('@guard:zhimo-reclass-end', start)
  return codeOnly(src.slice(start, end > start ? end : src.length))
}

// ── ① 设置项语义 ─────────────────────────────────────────────────────
describe('zhimoAutoCategory 设置项（默认开，缺键 / 脏值都回落 true）', () => {
  const base = (): Partial<Settings> => ({ libraryDir: 'E:\\ModVault\\Library' })

  it('默认值为 true（DEFAULT_SETTINGS 与 normalizeSettings 两条路都得是开）', () => {
    expect(DEFAULT_SETTINGS.zhimoAutoCategory).toBe(true)
    expect(normalizeSettings(base()).zhimoAutoCategory).toBe(true)
  })

  it('显式关闭被保留（只认严格 false）', () => {
    expect(normalizeSettings({ ...base(), zhimoAutoCategory: false }).zhimoAutoCategory).toBe(false)
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, zhimoAutoCategory: false }).zhimoAutoCategory
    ).toBe(false)
  })

  it('脏值（字符串 / 数字 / null / 对象 / 数组）一律回落 true，且不抛错', () => {
    const dirty: unknown[] = ['yes', 'false', 1, 0, null, {}, []]
    for (const v of dirty) {
      const s = normalizeSettings({ ...base(), zhimoAutoCategory: v } as unknown as Partial<Settings>)
      expect(s.zhimoAutoCategory).toBe(true)
    }
  })

  it('单项降级：脏值不拖垮整份设置（libraryDir 仍在）', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: 'E:\\ModVault\\Library',
      zhimoAutoCategory: 'yes'
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const settings = migrateSettings(parsed.data)
    expect(settings.zhimoAutoCategory).toBe(true)
    expect(settings.libraryDir).toBe('E:\\ModVault\\Library')
  })

  it('旧档缺键 → migrateSettings 回落 true，且库路径不丢', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\ModVault\\Library' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const settings = migrateSettings(parsed.data)
    expect(settings.zhimoAutoCategory).toBe(true)
    expect(settings.libraryDir).toBe('E:\\ModVault\\Library')
  })

  it('显式 false 能穿过 zod + 归一化（否则用户关了又被静默打开）', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: 'E:\\ModVault\\Library',
      zhimoAutoCategory: false
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(migrateSettings(parsed.data).zhimoAutoCategory).toBe(false)
  })
})

// ── ② 设置页接线守卫 ────────────────────────────────────────────────
describe('设置页接线：开关 / 手动入口 / 进度 / 取消 / 撤销', () => {
  const dialog = read('renderer/components/SettingsDialog.tsx')
  const code = codeOnly(dialog)

  it('「导入」tab 里有开关，且写库走 saveSettings（复用既有 Row + Toggle）', () => {
    const importTab = code.slice(code.indexOf('const importTab = ('), code.indexOf('const libraryTab = ('))
    expect(importTab).toContain('按站方分类自动落库')
    expect(importTab).toMatch(/<Toggle[\s\S]{0,240}zhimoAutoCategory/)
    expect(importTab).toMatch(/saveSettings\(\{\s*zhimoAutoCategory:\s*v\s*\}\)/)
  })

  it('说明文案交代了三件事：只处理未分类、已分类不动、手动按钮不受开关影响', () => {
    const importTab = code.slice(code.indexOf('const importTab = ('), code.indexOf('const libraryTab = ('))
    expect(importTab).toContain('只处理未分类的资产')
    expect(importTab).toContain('已分类的一律不动')
    expect(importTab).toContain('手动按钮不受此开关影响')
  })

  it('手动入口接的是 store 的真实 action（跑 / 取消 / 撤销）', () => {
    expect(code).toContain('runZhimoCategoryReclass(')
    expect(code).toContain('cancelZhimoCategoryReclass(')
    expect(code).toContain('undoLastReclassify(')
    // 撤销必须走**知末通道前缀**（用常量，不手抄字符串）
    expect(code).toContain('undoLastReclassify(ZHIMO_RECLASS_BACKUP_PREFIX)')
    expect(code).toContain('refreshZhimoReclassBackupCount')
  })

  it('候选数用纯逻辑同一个判定函数在渲染层算（不另写一套）', () => {
    expect(dialog).toContain("from '../logic/zhimoReclass'")
    expect(code).toContain('isZhimoReclassCandidate')
    expect(code).toMatch(/useMemo\(\s*\(\)\s*=>\s*allAssets\.filter\(isZhimoReclassCandidate\)\.length/)
  })

  it('确认弹窗存在，并明示「会真实移动目录」', () => {
    expect(code).toContain('确认按站方分类重排')
    expect(code).toContain('会真实移动磁盘上的目录')
  })

  it('运行中显示「已完成 x / 共 y」+ 取消按钮，且写明取消不等于回滚', () => {
    // 进度块抽在组件顶部（段落与确认弹窗共用），所以按整份组件源码断言
    expect(code).toContain('已完成')
    expect(code).toContain('/ 共')
    expect(code).toContain('取消只是不再抓新记录')
    expect(code).toContain('已抓到的结果会照常落库')
  })

  it('结束后列出新通道的桶，约归并未被丢掉并注明「近似归并」', () => {
    // T-14（docs/35）：通道换成三源交叉验证后，界面口径是
    // moved / unverified / approx / conflicts / unmapped / noStation / failed。
    // `ambiguous` 被**刻意移除**（新通道恒 0，展示一个永远 0 的词只会误导），
    // 它从界面消失这件事由 `tests/settingsReclassSummary.test.ts` 的反向断言守住。
    for (const bucket of [
      'moved',
      'unverified',
      'approx',
      'conflicts',
      'unmapped',
      'noStation',
      'failed'
    ]) {
      expect(code).toContain(`zhimoReclassResult.${bucket}`)
    }
    expect(code).toContain('近似归并')
    expect(dialog).toContain('「近似归并」= 站方类目在本地没有一一对应')
  })

  it('撤销入口文案：可撤销份数 + 「只保留最近 3 份」', () => {
    const section = zhimoSectionSource()
    expect(section).toContain('撤销上次知末重排')
    expect(section).toContain('可撤销备份')
    expect(section).toContain('只保留最近 3 份')
  })

  it('备份通道前缀在 UI 里可见（zhimo-reclass-），不会和 reclass- 混为一谈', () => {
    expect(dialog).toContain('zhimo-reclass-')
  })
})

// ── ③ 控件形态硬红线（自绘，不要系统默认控件） ───────────────────────
describe('新加控件不许是原生 checkbox / select', () => {
  const section = zhimoSectionSource()

  it('这段源码确实被切出来了（防止 indexOf 失败导致空字符串"全过"）', () => {
    expect(section.length).toBeGreaterThan(500)
    expect(section).toContain('zhimoReclass')
  })

  it('没有 type="checkbox"，也没有 <select', () => {
    expect(section).not.toContain('type="checkbox"')
    expect(section).not.toMatch(/<select\b/)
    expect(section).not.toMatch(/<input\b[^>]*type=["']checkbox/)
    expect(section).not.toMatch(/\bchecked=/)
  })

  it('整份设置页仍然零原生复选框（与本轮之前的红线一致）', () => {
    const dialogCode = codeOnly(read('renderer/components/SettingsDialog.tsx'))
    expect(dialogCode).not.toContain('type="checkbox"')
    expect(dialogCode).not.toMatch(/<select\b/)
  })
})

// ── ④ store 侧：可选前缀参数 + 新计数器 ──────────────────────────────
describe('store.undoLastReclassify 支持通道前缀（老调用点不改）', () => {
  const store = read('renderer/store.ts')

  it('实现带默认参数 prefix: string = \'reclass-\'', () => {
    expect(store).toMatch(/async undoLastReclassify\(\s*prefix:\s*string\s*=\s*'reclass-'\s*\)/)
    // 接口签名保持"可选"，老调用点（不传参）类型不变
    expect(store).toMatch(/undoLastReclassify:\s*\(prefix\?:\s*string\)\s*=>\s*Promise<ReclassUndoSummary>/)
  })

  it('老通道前缀字面量仍在，且备份读取按传入前缀过滤', () => {
    expect(store).toContain("'reclass-'")
    expect(store).toMatch(/async function listReclassBackups\(prefix: string = 'reclass-'\)/)
    expect(store).toMatch(/listReclassBackups\(prefix\)/)
  })

  it('新增 zhimoReclassBackupCount 状态与刷新动作（初值 0，独立于 reclassifyBackupCount）', () => {
    expect(store).toMatch(/zhimoReclassBackupCount:\s*number/)
    expect(store).toMatch(/zhimoReclassBackupCount:\s*0/)
    expect(store).toMatch(/async refreshZhimoReclassBackupCount\(\)/)
    expect(store).toMatch(/listReclassBackups\(ZHIMO_RECLASS_BACKUP_PREFIX\)/)
  })

  it('开关读取改成类型化字段（不再 cast 成可选扩展）', () => {
    expect(store).toContain('settings?.zhimoAutoCategory !== false')
    expect(store).not.toContain('Settings & { zhimoAutoCategory?: boolean }')
  })

  it('老调用点一行未改：设置页仍有一次不带参数的 undoLastReclassify()', () => {
    expect(read('renderer/components/SettingsDialog.tsx')).toContain('await undoLastReclassify()')
  })
})
