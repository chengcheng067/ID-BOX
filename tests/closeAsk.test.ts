/**
 * 「关闭窗口时」三档（`ask` = 每次询问【默认】 · `quit` = 彻底退出 · `tray` = 退至后台）。
 *
 * 2026-11 用户需求原话：
 * > 「那我需要有弹窗。如果用户没有在弹窗上默认勾选"记住"的设置，那么以后都会弹窗，
 * >   点关闭的话，然后就是改退至后台」
 *
 * 已定口径：**默认 `'ask'`**（点 ✕ 弹窗问一次，用户选了才执行）。
 * 老档缺键的升级用户落在这里是**刻意**的 —— 比静默退出安全（静默退出会掐断正在跑的
 * 导入与分类），且用户第一次点 ✕ 就看到了选择机会。
 *
 * 这份守卫钉五件事：
 * ① `DEFAULT_SETTINGS.closeBehavior === 'ask'` —— 默认值不许被改回静默退出；
 * ② `normalizeCloseBehavior` 是唯一归一化入口：三值往返，脏值 / 缺键一律 `'ask'`；
 * ③ zod 侧**单项降级**：`closeBehavior` 写坏不能拖垮整份 settings.json
 *    （`libraryDir` 必须还在 —— 本仓库在 gridDensity / trashRetention / motionQuality
 *    上都踩过"裸 enum 让整份 parse 失败"的坑）；
 * ④ `CloseAskDialog` 的三条关闭口径与自绘复选框（本仓 vitest 是 `environment:'node'`、
 *    **无 jsdom**，UI 只能靠源码守卫 + 纯函数）；
 * ⑤ `main/index.ts` 的 close 拦截真的走 `'ask'` 分支、有超时、兜底动作是 `'tray'`。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import {
  SettingsSchema,
  migrateSettings,
  normalizeCloseBehavior,
  normalizeSettings
} from '../src/main/settings'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

/**
 * 去掉注释后再断言「不该存在的东西」。
 * 守卫要防的是**代码**回退，不是注释里提到过 `type="checkbox"` 或 `'quit'`
 * （本次修复的注释必须写清「为什么不用原生控件」，否则下一个人会改回去）。
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释 + JSX 的 {/* … */}
    .replace(/^\s*\/\/.*$/gm, '') // 整行 // 注释
}

const CLOSE_ASK_DIALOG = 'src/renderer/components/CloseAskDialog.tsx'
const MODAL = 'src/renderer/components/Modal.tsx'
const MAIN = 'src/main/index.ts'
const SETTINGS_DIALOG = 'src/renderer/components/SettingsDialog.tsx'
const APP = 'src/renderer/App.tsx'

describe('DEFAULT_SETTINGS.closeBehavior', () => {
  it('默认「每次询问」= 点 ✕ 弹窗问一次，用户选了才执行', () => {
    expect(DEFAULT_SETTINGS.closeBehavior).toBe('ask')
  })
})

describe('normalizeCloseBehavior（唯一归一化入口）', () => {
  it('三个合法档位原样保留（三值往返）', () => {
    expect(normalizeCloseBehavior('ask')).toBe('ask')
    expect(normalizeCloseBehavior('quit')).toBe('quit')
    expect(normalizeCloseBehavior('tray')).toBe('tray')
  })

  it('缺键 / 脏值一律回落 ask（每次询问，比静默退出安全）', () => {
    const dirtyValues: unknown[] = [
      undefined,
      null,
      '',
      'ASK',
      'Ask',
      'ask ',
      'minimize',
      'hide',
      'background',
      1,
      0,
      true,
      {},
      []
    ]
    for (const dirty of dirtyValues) {
      expect(normalizeCloseBehavior(dirty), JSON.stringify(dirty)).toBe('ask')
    }
  })
})

describe('SettingsSchema：closeBehavior 单项降级', () => {
  it('缺键 → 不报错，parse 后为 undefined（由 normalize 收口成 ask）', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.closeBehavior).toBeUndefined()
  })

  it('脏值只让这一项回落 ask，libraryDir 不被拖垮', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehavior: 'minimize' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.closeBehavior).toBe('ask')
      expect(parsed.data.libraryDir).toBe('E:\\Lib')
    }
  })

  it('三个合法档位都能过 schema', () => {
    for (const value of ['ask', 'quit', 'tray'] as const) {
      const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehavior: value })
      expect(parsed.success, value).toBe(true)
      if (parsed.success) expect(parsed.data.closeBehavior).toBe(value)
    }
  })
})

describe('normalizeSettings（写档前收口）', () => {
  it('缺键 → 补默认 ask', () => {
    expect(normalizeSettings({}).closeBehavior).toBe('ask')
  })

  it("用户主动选的 'quit' / 'tray' 原样保留（不能被归一化吃掉）", () => {
    expect(normalizeSettings({ closeBehavior: 'quit' }).closeBehavior).toBe('quit')
    expect(normalizeSettings({ closeBehavior: 'tray' }).closeBehavior).toBe('tray')
  })

  it('脏值 → ask', () => {
    // 渲染层 patch 可能带进任意值，归一化后必须是合法档位
    expect(normalizeSettings({ closeBehavior: 'background' as never }).closeBehavior).toBe('ask')
  })
})

describe('migrateSettings（读档侧收口）', () => {
  it('旧档缺 closeBehavior → ask（每次询问，不是静默退出）', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', theme: 'dark' })
    const next = migrateSettings(raw)
    expect(next.closeBehavior).toBe('ask')
    // 其余字段照旧读进来，迁移没有副作用
    expect(next.libraryDir).toBe('E:\\Lib')
    expect(next.theme).toBe('dark')
  })

  it('已选「退至后台」的档读回来仍是 tray', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', closeBehavior: 'tray' })
    expect(migrateSettings(raw).closeBehavior).toBe('tray')
  })

  it('已选「彻底退出」的档读回来仍是 quit（记住过的选择不能被改回 ask）', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', closeBehavior: 'quit' })
    expect(migrateSettings(raw).closeBehavior).toBe('quit')
  })
})

// ── 源码守卫：`CloseAskDialog` 的三条关闭口径 ───────────────────────────
//
// 本仓 vitest 是 `environment:'node'`、无 jsdom，渲染不了 React 组件 ——
// 所以把"必须成立的结构"钉在源码上（与 categoryPicker / sortMenu / checkbox 同纪律）。

describe('CloseAskDialog（源码守卫）', () => {
  const src = read(CLOSE_ASK_DIALOG)
  const code = codeOf(src)

  it('点遮罩 / 按 Esc 都不关闭（必须明确点两个按钮之一）', () => {
    expect(code).toContain('dismissOnScrim={false}')
    expect(code).toContain('dismissOnEsc={false}')
  })

  it('不渲染右上角 ✕（Modal 的 showCloseButton 必须显式关掉）', () => {
    expect(code).toContain('showCloseButton={false}')
  })

  it('复选框自绘：不许出现原生 <input type="checkbox">', () => {
    expect(code).not.toContain('type="checkbox"')
    expect(code).not.toContain('<input')
    // 自绘结构：role="checkbox" + aria-checked（无障碍语义靠它，别为了"自绘"把语义也丢了）
    expect(code).toContain('role="checkbox"')
    expect(code).toContain('aria-checked={remember}')
  })

  it('复选框默认不勾（初始 false，且新询问到达时复位）', () => {
    expect(code).toContain('useState(false)')
    // 每次新的 requestId 都要回到未勾选 —— 否则上一次勾的会残留到下一次询问
    expect(code).toContain('setRemember(false)')
  })

  it('答复带 remember 字段（主进程据此决定是否落 closeBehavior）', () => {
    expect(code).toContain('answerClose')
    expect(code).toMatch(/remember[,}\s]/)
    // 两个动作都要能发出去
    expect(code).toContain("submit('quit')")
    expect(code).toContain("submit('tray')")
  })

  it('术语统一为「退至后台」，不写「收进托盘」（注释除外：注释必须解释为什么不用它）', () => {
    expect(code).toContain('退至后台')
    expect(code).not.toContain('收进托盘')
  })

  it('文案与设计稿逐字一致（标题 / 正文 / 复选框 / 设置页路径提示）', () => {
    expect(src).toContain('关闭 ID BOX')
    expect(src).toContain('要把 ID BOX 退至后台继续运行，还是彻底退出？')
    expect(src).toContain('记住我的选择，以后不再询问')
    expect(src).toContain('随时可在「设置 · 外观 · 窗口与后台」改回来')
    expect(src).toContain('彻底退出')
  })
})

describe('Modal（showCloseButton 向后兼容）', () => {
  const src = read(MODAL)

  it('新增可选 prop，默认 true（其它调用点零改动）', () => {
    expect(src).toContain('showCloseButton?: boolean')
    expect(src).toContain('showCloseButton = true')
  })

  it('✕ 按钮真的被条件包裹（不是只加了 prop 没用上）', () => {
    expect(src).toContain('{showCloseButton && (')
  })
})

// ── 源码守卫：主进程的 close 拦截 ────────────────────────────────────
//
// 关窗询问是"主进程问、渲染层答"，没有中间纯函数可测 —— 但**分支结构与兜底动作**
// 必须钉死，否则后人把 `'ask'` 分支删掉、或把超时兜底从 tray 改成 quit（等于
// 「用户没答就丢数据」），都不会有任何测试红。

describe('main/index.ts（关窗询问的 close 拦截）', () => {
  const src = read(MAIN)

  it('close 拦截读三档并包含 ask 分支', () => {
    expect(src).toContain("const behavior = settings.closeBehavior")
    expect(src).toContain("behavior !== 'ask'")
    expect(src).toContain("behavior !== 'tray'")
  })

  it('ask 分支先 preventDefault 再问（异步期间窗口不能真的关）', () => {
    // preventDefault 出现在"一律拦下"的位置，且 sendCloseAsk 在同一段里被 await
    expect(src).toContain('closeAskInFlight')
    expect(src).toContain('await sendCloseAsk()')
    expect(src).toMatch(/e\.preventDefault\(\)[\s\S]{0,400}closeAskInFlight = true/)
  })

  it('有 15s 超时，且超时兜底动作是 tray（不是 quit）', () => {
    expect(src).toContain('CLOSE_ASK_TIMEOUT_MS = 15_000')
    // 兜底表达式：只有明确 quit 才 quit，其余（含 null = 超时 / 无窗口）一律 tray
    expect(src).toMatch(/answer\?\.action === 'quit' \? 'quit' : 'tray'/)
    expect(src).toContain('resolve(null)')
    expect(src).toContain("logWarn('close:ask:timeout'")
  })

  it('超时会推 closeAskExpired 让渲染层关弹窗（DEF-19-1 同类问题）', () => {
    expect(src).toContain('IPC.closeAskExpired')
  })

  it('挂起的询问在四个终止点都被兑现（否则 close 的 await 会永久停住）', () => {
    // 调用点数 = 4：app-relaunch / before-quit / render-gone / window-closed
    const calls = src.split('clearPendingCloseAsks(').length - 1
    // 1 次函数声明 + 4 次调用
    expect(calls).toBeGreaterThanOrEqual(5)
    for (const reason of ['app-relaunch', 'before-quit', 'render-gone', 'window-closed']) {
      expect(src, reason).toContain(`clearPendingCloseAsks('${reason}')`)
    }
  })

  it('答复 handler 按 requestId 兑现，未知 id 静默丢弃', () => {
    expect(src).toContain('ipcMain.handle(IPC.closeAnswer')
    expect(src).toContain('pendingCloseAsks.get(requestId)')
    expect(src).toMatch(/if \(!resolve\)[\s\S]{0,200}return/)
  })

  it('记入设置后要走既有链路：saveSettings + syncTrayWithSettings + broadcast', () => {
    // 不新造函数名：这三步就是 `IPC.setSettings` handler 的那一套
    expect(src).toContain('settings = normalizeSettings({ ...settings, closeBehavior: action })')
    expect(src).toContain('await saveSettings(settings)')
    expect(src).toContain('syncTrayWithSettings()')
    expect(src).toContain('broadcastSettingsChanged(settings)')
  })

  it('「退至后台」不能裸 hide：必须先补托盘图标（否则窗口与托盘两份入口同时消失）', () => {
    // 'ask' 档下 `syncTrayWithSettings` 不会建图标（它只认 'tray'），所以收进后台这一步
    // 自己负责补齐 —— 这是 `syncTrayWithSettings` 里那段"两份入口同时没"注释的同一条纪律。
    expect(src).toContain('function hideToBackground()')
    expect(src).toMatch(/function hideToBackground\(\): void \{[\s\S]{0,600}createTray\(\)[\s\S]{0,200}win\.hide\(\)/)
    // 'ask' 分支里（成功 / 异常兜底两条路）不许再出现裸 `win?.hide()` ——
    // 都必须经 hideToBackground（'tray' 档的 hide 是另一段，不在此列）。
    // 剥注释后再判：注释里正是写着"不能裸 win?.hide()"这句话来解释为什么这么做。
    const askBranch = codeOf(
      src.slice(src.indexOf('closeAskInFlight = true'), src.indexOf('const sendMaximized'))
    )
    expect(askBranch).not.toContain('win?.hide()')
    expect(askBranch).toContain('hideToBackground()')
  })

  it('「退至后台」的后台态不被后续 settings:set 推翻（backgroundHold）', () => {
    // 场景：'ask' 档 + 用户选「退至后台」但没勾记住 → closeBehavior 仍是 'ask'。
    // 若 syncTrayWithSettings 照旧只认 'tray'，用户改个主题就会：销毁托盘 + 把窗口弹出来。
    expect(src).toContain('let backgroundHold = false')
    // syncTrayWithSettings 必须在销毁/唤回之前放行这条临时态
    expect(src).toMatch(
      /function syncTrayWithSettings\(\): void \{[\s\S]{0,600}if \(backgroundHold\) return[\s\S]{0,400}destroyTray\(\)/
    )
    // 置真点（收进后台）/ 置假点（窗口重新显示）
    expect(src).toMatch(/createTray\(\)[\s\S]{0,200}backgroundHold = true[\s\S]{0,60}win\.hide\(\)/)
    expect(src).toMatch(/function showMainWindow\(\): void \{[\s\S]{0,400}backgroundHold = false/)
  })

  it('second-instance 走 showMainWindow（否则 backgroundHold 永远清不掉）', () => {
    const block = src.slice(src.indexOf("app.on('second-instance'"), src.indexOf('registerVaultScheme()'))
    expect(block).toContain('showMainWindow()')
    // 不许再裸 show/focus：那条路会绕过 backgroundHold 的清理
    expect(codeOf(block)).not.toContain('win.show()')
    expect(codeOf(block)).not.toContain('win.focus()')
  })
})

describe('SettingsDialog（三档分段单选）', () => {
  const src = read(SETTINGS_DIALOG)

  it('三档齐全，默认标记落在 ask 上', () => {
    expect(src).toContain("{ value: 'ask', label: '每次询问'")
    expect(src).toContain("{ value: 'quit', label: '彻底退出'")
    expect(src).toContain("{ value: 'tray', label: '退至后台'")
    expect(src).toContain("opt.value === 'ask' && (")
  })

  it('三个标签等长（4 字对 4 字，分段单选才不会一长一短）', () => {
    for (const label of ['每次询问', '彻底退出', '退至后台']) {
      expect(label.length, label).toBe(4)
    }
  })

  it('术语统一为「退至后台」，不写「收进托盘」（注释除外）', () => {
    expect(codeOf(src)).not.toContain('收进托盘')
  })
})

describe('App.tsx（关窗询问的挂载与退订）', () => {
  const src = read(APP)

  it('订阅两条下行并在 cleanup 里退订', () => {
    expect(src).toContain('window.modvault.onCloseAsk(')
    expect(src).toContain('window.modvault.onCloseAskExpired(')
    expect(src).toMatch(/return \(\) => \{[\s\S]{0,200}offAsk\(\)[\s\S]{0,100}offExpired\(\)/)
  })

  it('弹窗无条件挂载（内部自己判 null）', () => {
    expect(src).toContain('<CloseAskDialog ask={closeAsk}')
  })

  it('作废事件只清匹配的 requestId（迟到作废不能关掉下一次询问）', () => {
    expect(src).toContain('current.requestId === ev.requestId ? null : current')
  })
})