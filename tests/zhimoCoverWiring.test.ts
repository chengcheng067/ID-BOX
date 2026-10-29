/**
 * 知末封面**接线守卫**（docs/24 §7 T-05；写法参照 `tests/aliasWiring.test.ts`）。
 *
 * 这里不跑运行时（Electron / IPC 在 node 里没有），而是对**源码文本**做断言，
 * 专治"功能写了但没接上"这类回归：
 * - 三处通道名必须一致（`shared/ipc.ts` / `preload` / `main`）；
 * - 主进程 handler 必须做库内越界校验（核心模块**故意**不做）；
 * - 详情面板按钮只对 `model` 渲染、无 ID 时禁用、**不读两个设置开关**；
 * - 设置页两个 patch 键名正确、子开关 `disabled` 绑定总开关且**只置灰不改值**；
 * - store 里 `commitCover` 三处共用、rescan 保活含 `'zhimo'`、自动任务静默（无 notice）;
 * - 渲染层纯逻辑文件不碰 `window` / `db`（可单测的前提）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

function readSrc(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

/** 取两个锚点之间的源码片段（用于"这个函数里没有某样东西"的断言） */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `源码里找不到锚点：${from}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf(to, start + from.length)
  expect(end, `源码里找不到结束锚点：${to}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('IPC 三处接线：通道名一致', () => {
  it('shared/ipc.ts 定义 `fetchZhimoCover: \'zhimo:fetchCover\'`，且注释写明分工', () => {
    const src = readSrc('../src/shared/ipc.ts')
    expect(src).toContain("fetchZhimoCover: 'zhimo:fetchCover'")
    expect(src).toContain('抓取 + 落盘在主进程')
    expect(src).toContain('写 Dexie 在渲染层')
  })

  it('preload 暴露 fetchZhimoCover(payload) → invoke(IPC.fetchZhimoCover)', () => {
    const src = readSrc('../src/preload/index.ts')
    expect(src).toContain('FetchZhimoCoverPayload')
    expect(src).toContain('FetchZhimoCoverResult')
    expect(src).toContain('fetchZhimoCover: (payload: FetchZhimoCoverPayload)')
    expect(src).toContain('ipcRenderer.invoke(IPC.fetchZhimoCover, payload)')
  })

  it('main 注册 handler，且先做 isWithinRoot 越界校验', () => {
    const src = readSrc('../src/main/index.ts')
    expect(src).toContain('refreshZhimoCoverInto')
    expect(src).toContain('ipcMain.handle(')
    expect(src).toContain('IPC.fetchZhimoCover')
    // 越界 → write-failed（IPC 表面只有一种形状）
    expect(src).toContain("reason: 'write-failed'")
    expect(src).toContain('isWithinRoot(lib, folder, path.sep)')
    expect(src).toContain("logWarn('zhimo:cover-failed'")
    expect(src).toContain("logWarn('zhimo:cover-watermarked'")
    // 失败不是异常：不能用 logError（否则日志噪音顶满）
    const handler = sliceBetween(src, 'IPC.fetchZhimoCover', 'ipcMain.handle(IPC.rescan')
    expect(handler).not.toContain('logError')
  })
})

describe('详情面板：按钮只对 model、无 ID 禁用、不受开关约束', () => {
  const src = readSrc('../src/renderer/components/DetailPanel.tsx')

  it('引入 zhimoIdOf，并在 isZhimoCoverKind（model / cad）时才渲染按钮', () => {
    expect(src).toContain("from '../../shared/naming'")
    expect(src).toContain('zhimoIdOf(asset.name)')
    // 2026-10：门槛从裸的 `kind === 'model'` 收进 `isZhimoCoverKind()`（CAD 也能抓）
    expect(src).toContain('isZhimoCoverKind(asset.kind)')
    expect(src).not.toContain("asset.kind === 'model'")
    expect(src).toContain('从知末取封面')
  })

  it('无 ID / 抓取中 → disabled，且 title 说明原因', () => {
    expect(src).toContain('disabled={!zhimoId || zhimoCoverBusy}')
    // 0.6.3：ID 不再只来自资产名（也可能来自压缩包名）→ 文案改口径并给出可行动出路
    expect(src).toContain('未识别到知末 ID，无法从知末取封面（把原始压缩包重新拖进来可补上）')
    expect(src).not.toContain('资产名里没有知末 ID')
    expect(src).toContain('正在从知末获取…')
    // 「不做二次确认」的正当性依据：必须把"会替换"写在 title 里
    expect(src).toContain('从知末取封面（会替换当前封面）')
  })

  it('0.6.3：ID 取值必须**优先 asset.zhimoId**，为空才退回名字解析', () => {
    // 压缩包名带 ID 的资产（`现代壁灯ID_1232108421.rar`）名字里没有 ID ——
    // 只看 asset.name 会让按钮对这类资产永远是灰的（用户反馈第 1 条）
    expect(src).toContain('asset.zhimoId')
    expect(src).toContain('zhimoIdOf(asset.name)')
    expect(src).toMatch(/String\(asset\.zhimoId \?\? ''\)\.trim\(\) \|\| zhimoIdOf\(asset\.name\)/)
    // disabled / loading 的既有语义一个字都不许变
    expect(src).toContain('disabled={!zhimoId || zhimoCoverBusy}')
  })

  it('点击走 store 的 refreshZhimoCover；**不读** 两个设置开关', () => {
    expect(src).toContain('refreshZhimoCover(asset.id)')
    expect(src).toContain('useVault((s) => s.zhimoCoverBusyId)')
    // 按资产判断 loading：别的资产不能被自动批次点亮
    expect(src).toContain('zhimoCoverBusyId === asset.id')
    // 手动按钮永远替换：一旦读到开关，M9/M10 的"关掉开关也能手动抓"就会失效
    expect(src).not.toContain('settings.zhimoCover')
    expect(src).not.toContain('settings.zhimoCoverReplacePacked')
  })
})

describe('设置页：两个 Toggle、patch 键名、子项置灰不改值', () => {
  const src = readSrc('../src/renderer/components/SettingsDialog.tsx')

  it('主开关 → saveSettings({ zhimoCover })', () => {
    expect(src).toContain('自动从知末获取模型封面')
    expect(src).toContain('saveSettings({ zhimoCover: v })')
  })

  it('子开关 → saveSettings({ zhimoCoverReplacePacked })，且 disabled 绑定总开关', () => {
    expect(src).toContain('包内已有预览图时也替换')
    expect(src).toContain('saveSettings({ zhimoCoverReplacePacked: v })')
    expect(src).toContain('disabled={settings.zhimoCover === false}')
    // 副文案必须原样（用户明确要求的解释：包内图可能是材质贴图）
    expect(src).toContain(
      '关闭后，压缩包里自带的图片会优先保留 —— 注意有些包自带的其实是材质贴图，不是模型预览。'
    )
  })

  it('Toggle 支持 disabled 且**不因 disabled 改值**（只置灰）', () => {
    const toggle = sliceBetween(src, 'function Toggle(', 'function Row(')
    expect(toggle).toContain('disabled?: boolean')
    expect(toggle).toContain('disabled={disabled}')
    expect(toggle).toContain('aria-checked={checked}')
    // 置灰不是改值：onChange 的参数仍由 checked 取反决定
    expect(toggle).toContain('onChange(!checked)')
  })
})

describe('store：commitCover 三处共用 / rescan 保活 / 自动任务静默', () => {
  const src = readSrc('../src/renderer/store.ts')

  it('commitCover 被定义一次、调用四处（setCover / setCoverFromImage / zhimo 队列 / 封面补抓）', () => {
    const calls = src.match(/commitCover\(/g) ?? []
    // 1 处定义 + 4 处调用：手动 zhimo 已改为复用 runZhimoCovers（DEF-Z1），不再有第四份落库逻辑；
    // 2026-10「一键重扫 · 从知末获取封面」（runZhimoCoverBackfill）复用同一落库路径，是第四处调用
    expect(calls.length).toBe(5)
    expect(src).toContain("() => commitCover(id, rel, 0, 'manual')")
    expect(src).toContain("await commitCover(id, res.rel, res.size, 'manual')")
    expect(src).toContain("await commitCover(t.id, res.rel, res.size, 'zhimo')")
  })

  it('files 合并要剔掉"根层同族封面"（换扩展名后旧条目不能指向已删文件）', () => {
    expect(src).toContain('isRootCoverRel')
    expect(src).toContain('!rel.includes(\'/\') && /\\.cover\\.[^./]+$/i.test(rel)')
    expect(src).toContain("f.rel !== rel && !isRootCoverRel(f.rel)")
  })

  it('rescan 保活：coverSource 为 manual 或 zhimo 都保留', () => {
    expect(src).toContain('keepStickyCover')
    expect(src).toContain("local.coverSource === 'manual' || local.coverSource === 'zhimo'")
    expect(src).toContain('coverSource: keepStickyCover ? local.coverSource : s.coverSource')
  })

  it('自动任务全程静默：runZhimoCovers 里每条 notice 都必须被 manual 门控', () => {
    const body = sliceBetween(src, 'async runZhimoCovers(', 'async refreshZhimoCover(')
    const hits = [...body.matchAll(/set\(\{ notice:/g)]
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      const before = body.slice(Math.max(0, (hit.index ?? 0) - 400), hit.index)
      // 要么在 `if (manual)` 块里，要么带 `manual ?` 三元 —— 自动路径永不出声
      expect(before).toContain('manual')
    }
  })

  it('手动复用同一入口（落库不复制），且**不再被批次锁拒绝**（DEF-Z8 第 4 条）', () => {
    const manual = sliceBetween(src, 'async refreshZhimoCover(', 'async saveSettings(')
    expect(manual).toContain('runZhimoCovers({')
    expect(manual).toContain('manual: true')
    expect(manual).toContain('force: true')
    // 旧的"正在后台获取封面，请稍后再试"拒绝式提示已删除：用户操作只排队不拒绝
    expect(manual).not.toContain('正在后台获取封面')
    // 手动不再自己调 IPC / 自己 commitCover（DEF-Z1 的根因就是那份复制品）
    expect(manual).not.toContain('window.modvault.fetchZhimoCover')
    expect(manual).not.toContain('commitCover(')
  })

  it('DEF-Z8：五条写入路径都在按资产锁内', () => {
    // 四处真实调用：setCover / setCoverFromImage / zhimo 的 fetchOne / 封面补抓的 fetchOne
    //（手动 zhimo 复用 fetchOne 自然继承同一把锁；补抓通道 2026-10 新增，同样走 fetchOne 锁）
    const hits = src.match(/withAssetCoverLock\(/g) ?? []
    expect(hits.length).toBe(4)
    expect(src).toContain("from './logic/coverLock'")

    const setCoverBody = sliceBetween(src, 'async setCover(id, rel)', 'async setCoverFromImage(')
    expect(setCoverBody).toContain('withAssetCoverLock(')

    const fromImage = sliceBetween(src, 'async setCoverFromImage(', 'async saveSettings(')
    expect(fromImage).toContain('withAssetCoverLock(')
    // 锁内不能嵌套 setCover（同 id 自锁 → 死锁）
    expect(fromImage).not.toContain('get().setCover(')

    const zhimoBody = sliceBetween(src, 'async runZhimoCovers(', 'async refreshZhimoCover(')
    expect(zhimoBody).toContain('withAssetCoverLock(')
    // 写盘 + 提交必须在同一段锁内（commitCover 出现在锁回调里）
      expect(zhimoBody).toContain("await commitCover(t.id, res.rel, res.size, 'zhimo')")
  })

  it('DEF-Z8：锁内重查（manual / zhimo 跳过，force 不跳）', () => {
    const body = sliceBetween(src, 'async runZhimoCovers(', 'async refreshZhimoCover(')
    expect(body).toContain("if (asset.coverSource === 'manual') return { skipped: true, reason: 'manual' }")
    expect(body).toContain("if (asset.coverSource === 'zhimo') return { skipped: true, reason: 'zhimo' }")
    // force 必须能绕过（手动按钮覆盖用户自己的封面是显式意图）
    expect(body).toContain('if (!opts?.force) {')
    // 重查必须在锁内：withAssetCoverLock 的回调里能找到 coverSource 判断
    const lockStart = body.indexOf('withAssetCoverLock(')
    const recheck = body.indexOf("if (!opts?.force) {")
    expect(lockStart).toBeGreaterThanOrEqual(0)
    expect(recheck).toBeGreaterThan(lockStart)
  })

  it('DEF-Z8：排队提示来自锁模块（3s 阈值常量导出）', () => {
    const lock = readSrc('../src/renderer/logic/coverLock.ts')
    expect(lock).toContain('export const COVER_LOCK_NOTICE_MS = 3000')
    expect(lock).toContain('export function withAssetCoverLock')
    expect(lock).toContain('export function pendingCoverLocks')
    // 纯模块：不碰 store / window / db
    expect(lock).not.toContain('useVault')
    expect(lock).not.toContain('window.')
    expect(lock).not.toContain("from '../db'")
    // 提示文案在 store 侧
    expect(src).toContain('正在后台写入封面，请稍候')
  })

  it('手动成功文案带分辨率', () => {
    const body = sliceBetween(src, 'async runZhimoCovers(', 'async refreshZhimoCover(')
    expect(body).toContain('已从知末更新封面')
    expect(body).toContain('res.width')
    expect(body).toContain('res.height')
  })

  it('busy 按资产（旧全局布尔已删除）', () => {
    expect(src).toContain('zhimoCoverBusyId')
    expect(src).not.toContain('zhimoCoverBusy:')
  })

  it('双触发都推到当前调用栈之外（setTimeout，不 await）', () => {
    expect(src).toContain('function scheduleZhimoCovers()')
    const sched = sliceBetween(src, 'function scheduleZhimoCovers()', 'function zhimoAutoCategoryEnabled')
    expect(sched).toContain('setTimeout(')
    expect(sched).toContain('runZhimoCovers()')

    // 0.7.8：两个触发点改走「先站方分类重排、再抓封面」的串行流水线
    // （并行打同一个站会让请求量翻倍、更易被 403）。
    // 守卫意图不变：① 必须离开导入的 Promise 链（setTimeout）；② 两个触发点都要走到。
    expect(src).toContain('function scheduleZhimoPipeline()')
    const pipeline = sliceBetween(src, 'function scheduleZhimoPipeline()', 'async function maybeAutoMigrate')
    expect(pipeline).toContain('setTimeout(')
    // 顺序写死：重排在前、封面在后（用下标比较，防止有人把两行对调）
    const reclassAt = pipeline.indexOf('runZhimoCategoryReclass(')
    const coverAt = pipeline.indexOf('runZhimoCovers()')
    expect(reclassAt).toBeGreaterThan(-1)
    expect(coverAt).toBeGreaterThan(-1)
    expect(reclassAt).toBeLessThan(coverAt)
    // 受开关控制：重排那一段必须在 zhimoAutoCategoryEnabled 判定之内
    expect(pipeline).toContain('zhimoAutoCategoryEnabled(')
    // onImportBatchDone 与 importPaths 收尾各触发一次
    expect(src.match(/scheduleZhimoPipeline\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('pending 只收 model / cad + 有 ID（材质/贴图不做）', () => {
    const enqueue = sliceBetween(src, 'function enqueueZhimoCover(', 'function emptyZhimoResult')
    // 2026-10 增 cad：这里曾经是第三处裸判断，必须与另外两处同走口径函数
    expect(enqueue).toContain('isZhimoCoverKind(asset.kind)')
    expect(enqueue).not.toContain("asset.kind !== 'model'")
    expect(enqueue).toContain('zhimoIdOf(asset.name)')
  })

  it('0.6.3：enqueueZhimoCover 必须先取 asset.zhimoId（P1 回归点，别再只认名字）', () => {
    // 漏这一处 → ID 只在压缩包名上的资产**永不入队**，默认开启的自动补封面对它们静默失效
    const enqueue = sliceBetween(src, 'function enqueueZhimoCover(', 'function emptyZhimoResult')
    expect(enqueue).toContain('asset.zhimoId')
    expect(enqueue).toMatch(/storedId \|\| zhimoIdOf\(asset\.name\)/)
    expect(enqueue).not.toMatch(/if \(!zhimoIdOf\(asset\.name\)\) return/)
  })
})

describe('渲染层纯逻辑：不碰 window / db', () => {
  it('logic/zhimoCover.ts 只依赖注入（可被 node 单测直接 import）', () => {
    const src = readSrc('../src/renderer/logic/zhimoCover.ts')
    // 注释里可以提到它（解释"为什么抽出来"），但**不能真的调用**
    expect(src).not.toContain('window.modvault.')
    expect(src).not.toContain('from \'../db\'')
    expect(src).not.toContain('useVault')
    // 依赖全部由参数注入
    expect(src).toContain('fetchOne')
    expect(src).toContain('shouldStop')
  })

  it('0.6.3：pickZhimoCoverTargets 也必须**优先 asset.zhimoId**', () => {
    // 自动任务与手动按钮必须同口径，否则「按钮能点、后台却不抓」= 半边功能
    const src = readSrc('../src/renderer/logic/zhimoCover.ts')
    expect(src).toContain('asset.zhimoId')
    expect(src).toContain('zhimoIdOf(asset.name)')
    expect(src).toMatch(/storedId \|\| zhimoIdOf\(asset\.name\)/)
  })
})
