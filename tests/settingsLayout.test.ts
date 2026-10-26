/// <reference lib="dom" />
/**
 * 设置弹窗 v0.8.1「信息架构重排 + 统一组件语言」验收（源码守卫）。
 *
 * 渲染层单测跑在 `environment: 'node'`（**没有 jsdom**），UI 只能扫源码钉断言。
 * 这份守卫要防的是**重排的两种典型翻车**：
 * ① 搬漏 —— 把一段 JSX 从一个 tab 搬到另一个 tab 时漏掉某个按钮/开关，
 *    界面上不报错，用户只是"找不到那个设置了"。这里按 tab 统计 `onClick=` 数量，
 *    与**搬迁前的实测基线**比（≥ 90%）。
 * ② 文档编号泄漏到 UI —— 历史上设置页出现过「低频操作，已从顶栏移入设置（§4-7）」
 *    这类给开发者看的编号（`§` + 数字），用户看不懂。整份源码（去注释后）不许再有。
 *
 * 另外钉住三件事：tab 数量/顺序（新增 classify、删掉 advanced）、左栏四个分组标签、
 * 四个新原语（SettingsCard / SettingsRow / StatusBadge / PageHeader）都存在且真的被用。
 *
 * ── `onClick=` 基线是怎么数出来的（搬迁前，commit 前工作区的 SettingsDialog.tsx）──
 * 按"内容归属"而不是"变量声明位置"逐条点：
 *   appearance : 主题三卡(map 1) + 动效三档(map 1)                              = 2
 *   import     : 压缩包处置(map 1) + 解压数 stepper(−/+) + 监控目录「选择目录」 = 5
 *   classify   : 重跑自动分类 / 撤销重跑 / 按站方重跑 / 撤销知末 / 一致性检查 / 测试连接 = 6
 *   library    : 更换库 / 打开库 / 重新扫描 / 恢复备份 / 强制重扫 / 迁移 / 立即合并 = 7
 *   alias      : 删一条 / 新增 / 导出 JSON / 导入 JSON(触发) / 采纳建议 / 加入选中项 = 6
 *   data       : 撤销期(map 1) + 保留期(map 1) + 清除缓存 + 导出索引 + 打开日志夹 + 导出日志 = 6
 *   about      : 去下载 + 立即检查                                           = 2
 * 合计 34。搬迁后只允许**多**（7-Zip「重新检测」与「在 GitHub 提 Issue」是本轮新增），
 * 每个 tab 的下限取 `Math.floor(基线 × 0.9)`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'SettingsDialog.tsx'
)

const raw = (): string => fs.readFileSync(COMPONENT, 'utf-8')

/** 去掉块注释与行注释：守卫只针对真实代码 / 用户可见文案，注释里出现 § 不算违规 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 按锚点切一段源码（找不到锚点时返回空串，由调用点自己断言"切到了"） */
function sliceBetween(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  if (a < 0) return ''
  const b = src.indexOf(to, a + from.length)
  return src.slice(a, b > a ? b : src.length)
}

/** 各 tab 的内容段（顺序与组件里的声明顺序一致：appearance → import → classify → library → data → about） */
const TAB_SLICES: { key: string; from: string; to: string }[] = [
  { key: 'appearance', from: 'const appearanceTab = (', to: 'const importTab = (' },
  { key: 'import', from: 'const importTab = (', to: 'const classifyTab = (' },
  { key: 'classify', from: 'const classifyTab = (', to: 'const libraryTab = (' },
  { key: 'library', from: 'const libraryTab = (', to: 'const dataTab = (' },
  { key: 'data', from: 'const dataTab = (', to: 'const aboutTab = (' },
  { key: 'about', from: 'const aboutTab = (', to: 'const forceGone' }
]

/**
 * 每个 tab 的 `onClick=` 下限（基线 × 0.9 向下取整，见文件头注释）。
 *
 * `alias` 的内容在独立组件 `AliasTab()` 里，单独切段统计。
 */
const CLICK_BASELINE: Record<string, number> = {
  appearance: 2,
  import: 5,
  classify: 6,
  library: 7,
  alias: 6,
  data: 6,
  about: 2
}

// ── ① tab 结构：7 项、顺序固定、没有 advanced ─────────────────────────
describe('tab 结构：7 项且顺序固定（新增 classify，删除 advanced）', () => {
  it('TABS 恰好 7 项，key 顺序 = appearance/import/classify/library/alias/data/about', () => {
    const src = raw()
    const block = sliceBetween(src, 'const TABS: { key: SettingsTab; label: string }[] = [', ']')
    expect(block.length).toBeGreaterThan(0)
    const keys = [...block.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1])
    expect(keys).toEqual(['appearance', 'import', 'classify', 'library', 'alias', 'data', 'about'])
    expect(keys).toHaveLength(7)
  })

  it('SettingsTab 联合类型里没有 advanced', () => {
    const src = raw()
    const line = src.slice(src.indexOf('type SettingsTab ='), src.indexOf('\n', src.indexOf('type SettingsTab =')))
    expect(line).toContain("'classify'")
    expect(line).not.toContain("'advanced'")
  })

  it('渲染分支里没有 `tab === \'advanced\'`，且 classify 有独立内容变量', () => {
    const code = codeOnly(raw())
    expect(code).not.toContain("tab === 'advanced'")
    expect(code).toContain("tab === 'classify' && classifyTab")
    expect(code).toContain('const classifyTab = (')
  })

  it('「库与分类」已改名「库」（分类独立成 tab 之后旧名字会误导）', () => {
    const src = raw()
    expect(src).toContain("{ key: 'library', label: '库' }")
    // 别名 tab 仍排在库 tab 之后（aliasWiring.test.ts 的同一条顺序口径）
    expect(src.indexOf("label: '别名'")).toBeGreaterThan(src.indexOf("{ key: 'library', label: '库' }"))
  })
})

// ── ② 弹窗尺寸（900×680）+ 小屏兜底 ──────────────────────────────────
describe('弹窗尺寸：900×680，小屏按视口收缩', () => {
  const code = codeOnly(raw())

  it('主容器是 900×680（v0.8.1 用户拍板，为了让卡片流尽量一屏放下）', () => {
    expect(code).toContain('h-[680px]')
    expect(code).toContain('w-[900px]')
  })

  it('没有残留旧尺寸 760×560', () => {
    expect(code).not.toContain('w-[760px]')
    expect(code).not.toContain('h-[560px]')
    expect(code).not.toContain('h-[560')
  })

  it('小屏兜底：max-h / max-w 按视口收缩（1280×720 上不会顶出屏幕）', () => {
    expect(code).toContain('max-h-[calc(100vh-48px)]')
    expect(code).toContain('max-w-[calc(100vw-48px)]')
  })

  it('页头在滚动容器之外且 shrink-0 —— 内容再长也不会把 ✕ 滚走', () => {
    const head = sliceBetween(code, 'function PageHeader(', 'function Row(')
    expect(head).toContain('shrink-0')
    expect(head).toContain('onClick={onClose}')
    // 滚动容器只包住 tab 内容（页头是它的兄弟节点，不在里面）
    expect(code).toMatch(/<PageHeader[\s\S]{0,160}\/>[\s\S]{0,400}ref=\{tabScrollRef\}/)
  })
})

// ── ③ 左栏分组 ────────────────────────────────────────────────────────
describe('左栏四个分组（偏好 / 素材 / 数据 / 其他）', () => {
  const src = raw()
  const groups = sliceBetween(src, 'const TAB_GROUPS:', 'const TAB_SUB')

  it('四个分组标签逐字存在', () => {
    for (const label of ['偏好', '素材', '数据', '其他']) {
      expect(groups).toContain(`label: '${label}'`)
    }
  })

  it('分组只列 key，不复制第二份标签文字（标签真源仍是 TABS）', () => {
    // TAB_GROUPS 里出现 `TABS.find(` 说明标签是从 TABS 查的，不是手抄的
    expect(src).toContain('TABS.find((t) => t.key === key)')
    // 组标签 10.5px + letter-spacing .1em（设计稿口径）
    expect(src).toContain('text-[10.5px] font-semibold tracking-[0.1em] text-muted')
  })

  it('版本号固定在左栏最底部（mt-auto 仍在）', () => {
    expect(src).toContain('mt-auto px-2.5 text-[11px] text-muted')
  })
})

// ── ③ 四个新原语：存在 + 每个 tab 至少一张卡 ──────────────────────────
describe('组件语言：SettingsCard / SettingsRow / StatusBadge / PageHeader', () => {
  const code = codeOnly(raw())

  it('四个原语都有定义', () => {
    expect(code).toContain('function SettingsCard(')
    expect(code).toContain('function SettingsRow(')
    expect(code).toContain('function StatusBadge(')
    expect(code).toContain('function PageHeader(')
  })

  it('SettingsCard 的规格：白卡 + 1px 面板描边 + 圆角 12 + 18px 左右内边距 + 11px 卡标题', () => {
    const card = sliceBetween(code, 'function SettingsCard(', 'function StatusBadge(')
    expect(card).toContain('rounded-xl')
    expect(card).toContain('border-panel-line')
    expect(card).toContain('bg-card')
    expect(card).toContain('px-[18px]')
    expect(card).toContain('text-[11px] font-semibold tracking-[0.08em]')
    // 危险区只用既有 danger token（不写死设计稿那两个浅色十六进制）
    expect(card).toContain('border-danger/40')
    expect(card).toContain('bg-danger-tint')
    expect(card).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // note：卡底通栏浅灰条（负边距抵消卡内边距 + 底圆角对齐）
    expect(card).toContain('-mx-[18px]')
    expect(card).toContain('rounded-b-xl')
    expect(card).toContain('text-[11.5px] leading-[1.7] text-tertiary')
  })

  it('SettingsRow：「标题 + ≤1 行摘要 + 右侧操作区」，行间 1px 且卡内首行无上分隔', () => {
    const row = sliceBetween(code, 'function SettingsRow(', 'function SettingsCard(')
    const layout = sliceBetween(code, 'function Row(', 'function SettingsRow(')
    expect(row).toContain('<Row')
    expect(row).toContain('actions')
    // 布局本体（Row）承载间距与分隔线
    expect(layout).toContain('border-t border-soft-line py-2.5 first:border-t-0')
    // 行高节奏 v0.8.1 收紧：10+10 padding + 17 标题(leading 1.25) + 4 + 18 摘要 ≈ 59
    expect(layout).toContain('text-[13.5px] font-medium leading-[1.25] text-primary')
    expect(layout).toContain('text-[12px] leading-[1.5] text-tertiary')
    expect(layout).toContain('shrink-0 flex-nowrap')
  })

  it('StatusBadge：三档色调 + 10.5px 胶囊，颜色全走既有 token', () => {
    const badge = sliceBetween(code, 'function StatusBadge(', 'function PageHeader(')
    expect(badge).toContain("'ok' | 'warn' | 'muted'")
    expect(badge).toContain('bg-success/15 text-success')
    expect(badge).toContain('bg-danger-tint text-danger')
    expect(badge).toContain('bg-neutral-tint text-neutral-tint-text')
    expect(badge).toContain('text-[10.5px]')
    expect(badge).toContain('rounded-full')
    expect(badge).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('PageHeader：17/600 标题 + 12 副标题 + 现有 ✕', () => {
    const head = sliceBetween(code, 'function PageHeader(', 'function Row(')
    expect(head).toContain('text-[17px] font-semibold text-primary')
    expect(head).toContain('text-[12px] text-tertiary')
    expect(head).toContain('onClick={onClose}')
    expect(head).toContain('title="关闭"')
  })

  it('每个 tab 至少用一次 SettingsCard（别名 tab 含在 AliasTab() 里）', () => {
    const src = codeOnly(raw())
    for (const { key, from, to } of TAB_SLICES) {
      const body = sliceBetween(src, from, to)
      expect(body.length, `${key} 段没切到`).toBeGreaterThan(500)
      expect(body, `${key} 没有 SettingsCard`).toContain('<SettingsCard')
    }
    const alias = sliceBetween(src, 'function AliasTab(', 'export function SettingsDialog')
    expect(alias.length).toBeGreaterThan(500)
    expect(alias).toContain('<SettingsCard')
  })

  it('SectionTitle 已被卡片标题取代（全文件不再引用）', () => {
    expect(code).not.toContain('<SectionTitle')
    expect(code).not.toContain('function SectionTitle(')
  })
})

// ── ④ 反馈卡的 GitHub Issue 入口 ──────────────────────────────────────
describe('关于页：GitHub Issue 入口走既有 openExternal 桥', () => {
  const src = raw()
  const code = codeOnly(src)

  it('反馈卡里有「在 GitHub 提 Issue」按钮，URL 指向本仓库 issues', () => {
    expect(code).toContain('在 GitHub 提 Issue')
    expect(code).toContain('https://github.com/chengcheng067/ID-BOX/issues')
  })

  it('点击走 window.modvault.openExternal（不新开桥、不拼 window.open）', () => {
    expect(code).toContain('window.modvault.openExternal(GITHUB_ISSUES_URL)')
    expect(code).not.toContain('window.open(')
  })

  it('openExternal 的返回值才是判据（它永不 reject，别拿 .catch 当主路径）', () => {
    // 契约：成功 true / 被拒或失败 false（主进程只放行 https:/http:）
    expect(code).toContain('const ok = await window.modvault.openExternal(GITHUB_ISSUES_URL)')
    expect(code).toMatch(/if \(!ok\)/)
    // 打开失败要给可行动的提示（不能静默什么都不发生）
    expect(code).toContain('链接打开失败，可手动访问 github.com/chengcheng067/ID-BOX/issues')
    // GitHub 这一处不许把 .catch 当主判据
    expect(code).toMatch(/openExternal\(GITHUB_ISSUES_URL\)(?!\s*\.catch)/)
  })

  it('二维码统一 146×146（两卡同尺寸，扫得出来）', () => {
    const support = sliceBetween(code, 'function SupportCard(', 'function ThemePreview(')
    expect(support).toContain('h-[146px] w-[146px]')
    // 白底是深色主题下可扫的前提
    expect(support).toContain('bg-white')
    expect(support).toContain('object-contain')
  })
})

// ── ⑤ 文案纪律：不许出现文档编号 ──────────────────────────────────────
describe('文案纪律：UI 里不许出现 §N 这类文档编号', () => {
  it('去注释后的源码不含 `§` + 数字', () => {
    expect(codeOnly(raw())).not.toMatch(/§\d/)
  })

  it('「低频操作，已从顶栏移入设置（§4-7）」这类开发者注释不再出现在 UI', () => {
    const code = codeOnly(raw())
    expect(code).not.toContain('低频操作，已从顶栏移入设置')
    expect(code).not.toContain('§4-7')
  })
})

// ── ⑥ 搬漏防线：每个 tab 的可点项数量 ────────────────────────────────
describe('搬迁不许漏按钮：每个 tab 的 onClick= 不少于基线 90%', () => {
  const src = codeOnly(raw())

  for (const { key, from, to } of TAB_SLICES) {
    const body = sliceBetween(src, from, to)
    const count = (body.match(/onClick=/g) ?? []).length
    const floor = Math.floor(CLICK_BASELINE[key] * 0.9)
    it(`${key}：${count} 个 onClick ≥ ${floor}（基线 ${CLICK_BASELINE[key]}）`, () => {
      expect(body.length).toBeGreaterThan(500)
      expect(count).toBeGreaterThanOrEqual(floor)
    })
  }

  it('alias：AliasTab() 里的可点项数量不低于基线', () => {
    const body = sliceBetween(src, 'function AliasTab(', 'export function SettingsDialog')
    const count = (body.match(/onClick=/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(Math.floor(CLICK_BASELINE.alias * 0.9))
  })

  it('全文件的 onClick= 总数不低于搬迁前（56）—— 只允许搬多，不允许搬丢', () => {
    const total = (src.match(/onClick=/g) ?? []).length
    expect(total).toBeGreaterThanOrEqual(56)
  })
})

// ── ⑦ 逐屏要点：界面元素不许在重排里"顺手降级"────────────────────────
describe('逐屏要点：危险区 / 徽标 / 状态位', () => {
  const code = codeOnly(raw())

  it('「强制重扫」在独立的 danger 卡里（红色只出现在危险区）', () => {
    const library = sliceBetween(code, 'const libraryTab = (', 'const dataTab = (')
    expect(library).toContain('<SettingsCard title="危险操作" danger>')
    expect(library).toContain('btn btn-danger')
    // 其他 tab 不出现 danger 卡
    expect(sliceBetween(code, 'const appearanceTab = (', 'const importTab = (')).not.toContain(
      'danger>'
    )
  })

  it('7-Zip 从「高级」搬进「导入 · 解压」，并带检测状态徽标', () => {
    const imp = sliceBetween(code, 'const importTab = (', 'const classifyTab = (')
    expect(imp).toContain('title="7-Zip"')
    expect(imp).toContain('StatusBadge tone="ok">已找到')
    expect(imp).toContain('StatusBadge tone="warn">未找到')
    // 检测仍复用既有 bridge，不新写 shell 调用（组件里可能为折行写成 `window.modvault\n  .sevenZipPath()`）
    expect(imp).toMatch(/window\.modvault\s*\.sevenZipPath\(\)/)
    expect(code).not.toContain('shell.exec')
  })

  it('结构迁移的两个"已迁移"状态用绿色徽标直说，而不是让人猜按钮为什么灰着', () => {
    const library = sliceBetween(code, 'const libraryTab = (', 'const dataTab = (')
    expect(library).toContain('StatusBadge tone="ok">无需迁移')
    expect(library).toContain('StatusBadge tone="ok">已完成')
  })

  it('分类 tab 收齐：自动落库开关 + 两条存量重排（各自撤销）+ 一致性检查', () => {
    const cls = sliceBetween(code, 'const classifyTab = (', 'const libraryTab = (')
    expect(cls).toContain('settings.zhimoAutoCategory')
    expect(cls).toContain('重跑自动分类')
    expect(cls).toContain('撤销上次重跑')
    expect(cls).toContain('按站方分类重跑')
    expect(cls).toContain('撤销上次知末重排')
    expect(cls).toContain('库一致性检查')
  })

  it('「检查」并入「存量重排」卡（同一心智单元，不再单开一张卡）', () => {
    const cls = sliceBetween(code, 'const classifyTab = (', 'const libraryTab = (')
    // 只有三张卡：导入时 / 存量重排 / AI
    expect((cls.match(/<SettingsCard/g) ?? []).length).toBe(3)
    expect(cls).not.toContain('title="检查"')
    const card = sliceBetween(cls, 'title="存量重排"', '<SettingsCard')
    expect(card).toContain('库一致性检查')
  })

  it('「可撤销备份 N 份」挪进卡底 note：右栏只留操作按钮', () => {
    const cls = sliceBetween(code, 'const classifyTab = (', 'const libraryTab = (')
    // note 里真的算出了份数（两个通道各自一份，合计为 0 时给"暂无"）
    expect(cls).toMatch(/reclassifyBackupCount \+ zhimoReclassBackupCount > 0/)
    expect(cls).toContain('可撤销备份')
    expect(cls).toContain('暂无可撤销备份')
    // 两条重排行内部不再有份数 span（右栏只剩按钮）
    const rows = sliceBetween(cls, 'title="重跑自动分类"', '<SettingsCard')
    expect(rows).not.toContain('可撤销备份')
    expect(rows).not.toContain('whitespace-nowrap text-[11px] text-muted')
  })

  it('AI 辅助分类默认折叠，可键盘展开，且折叠态看得出开关是开还是关', () => {
    // 默认收起（false），展开态只影响呈现、不清空已填字段
    expect(code).toMatch(/const \[aiOpen, setAiOpen\] = useState\(false\)/)
    // 原生 button + aria-expanded / aria-controls：Enter / Space 可用
    expect(code).toContain('aria-expanded={aiOpen}')
    expect(code).toContain('aria-controls="ai-classify-fields"')
    expect(code).toMatch(/<button[\s\S]{0,200}type="button"[\s\S]{0,200}aria-expanded=\{aiOpen\}/)
    // 折叠时字段整块不渲染（省高度），展开才出现
    expect(code).toContain('{aiOpen && (')
    expect(code).toContain('id="ai-classify-fields"')
    // 状态不藏：摘要第一句就是「已开启 · 模型 xxx」/「未开启」
    expect(code).toContain('已开启')
    expect(code).toContain('未开启')
    expect(code).toMatch(/已开启\$\{aiForm\.model\.trim\(\)/)
  })

  it('数据与备份：撤销期与保留期都收在行右侧的分段控件里（不再竖排占三行）', () => {
    const data = sliceBetween(code, 'const dataTab = (', 'const aboutTab = (')
    expect(data).toContain('UNDO_GRACE_OPTIONS.map')
    expect(data).toContain('RETENTION_OPTIONS.map')
    expect(data).toContain('SEG_GROUP_CLASS')
    // 撤销期文案口径：不等待仍会二次确认
    expect(data).toContain('仍会二次确认')
  })

  it('「路径长度提示」摘要是 1 行，gpedit / 注册表步骤在卡底 note 里（不许塞回行内）', () => {
    const data = sliceBetween(code, 'const dataTab = (', 'const aboutTab = (')
    const thisRow = sliceBetween(data, 'title="路径长度提示"', '/>')
    // 行内只有一行摘要：不许有 notice（那是第二块正文），也不许出现操作步骤
    expect(thisRow).not.toContain('notice=')
    expect(thisRow).not.toContain('gpedit')
    expect(thisRow).not.toContain('LongPathsEnabled')
    // 步骤下沉到「诊断日志」卡的 note（低频参考信息与日志说明同处）
    const cardNote = sliceBetween(data, 'title="诊断日志"', '<SettingsRow')
    expect(cardNote).toContain('gpedit.msc')
    expect(cardNote).toContain('LongPathsEnabled=1')
  })
})
