/**
 * 旧档遗留 `aiClassify` 键兼容性 + AI 辅助分类下线源码守卫（2026-11-11，C 档彻底移除）。
 *
 * 背景：用户拍板把「自接模型 API 辅助分类」整块拿掉（线上 API 从未跑通）。删代码容易，
 * 真正会炸的是**老用户 `settings.json` 里还留着 `aiClassify` 子对象**：读档时
 * schema / 迁移 / 归一化 / 整体覆写四层里任何一层引用了已删字段，都会让库路径丢失或抛错。
 *
 * 三层保障（本文件逐层钉住）：
 *   ① `SettingsSchema` 是 `z.object`，默认 strip 未知键 → 旧档的 `aiClassify` 在
 *      `safeParse` 这一步就被丢掉，`readSettingsFile` 不会失败；
 *   ② `migrateSettings` 的 `{ ...DEFAULT_SETTINGS, ...raw }` 只认已知键，
 *      `libraryDir` 等非默认字段原样保住，输出里不再有 `aiClassify`；
 *   ③ `saveSettings` 用 `normalizeSettings(s)` 的结果**整体覆写** settings.json，
 *      于是磁盘上的旧 `aiClassify` 键随下一次保存自然消失（不需要写专门的清理代码）。
 *
 * 「源码守卫」另钉住三件事，防日后回潮或误删共享通道：
 *   - `SettingsDialog.tsx` 里 `AI 辅助分类` / `模型兜底` / `aiClassify` 零命中；
 *   - `src/main/aiClassify.ts`（唯一 HTTP 实现）不存在；
 *   - `src/shared/ipc.ts` 里 `aiClassify` 零命中，但 `import:batchDone` 仍在
 *     （知末封面流水线 / 三源交叉验证 / 插件索引快照共用这条通道，绝不能顺手删掉）。
 *
 * 所有断言只读源码或纯逻辑，不碰真实库目录与 `%APPDATA%/idbox`。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateSettings, normalizeSettings, SettingsSchema } from '../src/main/settings'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf-8')

/** 模拟 v1.0.4 及之前用户磁盘上的 settings.json：带 AI 子对象 + 一个非默认库路径 */
const LEGACY_RAW = {
  libraryDir: 'D:\\LegacyVault\\Library',
  gridDensity: 'small',
  trashRetention: '10d',
  aiClassify: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8180/v1',
    apiKey: 'x',
    model: 'Stratia'
  }
}

/** 走与 `readSettingsFile` 完全相同的读档链路：JSON 字符串 → safeParse → migrate */
function readLikeLoadSettings(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw)
  expect(parsed.success).toBe(true)
  if (!parsed.success) throw new Error('旧档应能过 schema')
  return migrateSettings(parsed.data)
}

describe('旧档含已下线的 aiClassify 键 → 读档不炸、关键字段保住、废弃键被丢弃', () => {
  it('① 读档不抛错（safeParse 成功）', () => {
    expect(() => readLikeLoadSettings(LEGACY_RAW)).not.toThrow()
  })

  it('② libraryDir 等非默认关键字段原样保住（不被脏键拖垮整份设置）', () => {
    const s = readLikeLoadSettings(LEGACY_RAW)
    expect(s.libraryDir).toBe('D:\\LegacyVault\\Library')
    expect(s.gridDensity).toBe('small')
    expect(s.trashRetention).toBe('10d')
    // 未提供的字段仍补齐默认值
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(s.verboseLogging).toBe(DEFAULT_SETTINGS.verboseLogging)
  })

  it('③ 输出里没有 aiClassify 字段（z.object strip 未知键）', () => {
    const parsed = SettingsSchema.safeParse(LEGACY_RAW)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(Object.prototype.hasOwnProperty.call(parsed.data, 'aiClassify')).toBe(false)
    }
    const s = readLikeLoadSettings(LEGACY_RAW)
    expect(Object.prototype.hasOwnProperty.call(s, 'aiClassify')).toBe(false)
    expect('aiClassify' in s).toBe(false)
  })

  it('④ saveSettings 整体覆写：normalizeSettings 的结果序列化后不含 aiClassify', () => {
    const s = readLikeLoadSettings(LEGACY_RAW)
    const normalized = normalizeSettings(s)
    const json = JSON.stringify(normalized, null, 2)
    expect(json).not.toContain('aiClassify')
    // 反序列化后按字段比对（JSON.stringify 会把 Windows 路径里的 \ 转义成 \\）
    const written = JSON.parse(json) as Record<string, unknown>
    expect(written['libraryDir']).toBe('D:\\LegacyVault\\Library')
    expect(Object.prototype.hasOwnProperty.call(written, 'aiClassify')).toBe(false)
  })

  it('⑤ normalizeSettings() 对脏值（含整块废弃子对象 / 类型错误）仍不抛错', () => {
    const dirty = {
      libraryDir: 'D:\\LegacyVault\\Library',
      gridDensity: 'garbage',
      trashRetention: true,
      undoGraceMs: 'abc',
      motionQuality: 42,
      aiClassify: 'garbage'
    } as unknown as Partial<Settings>
    expect(() => normalizeSettings(dirty)).not.toThrow()
    const s = normalizeSettings(dirty)
    expect(s.libraryDir).toBe('D:\\LegacyVault\\Library')
    expect(s.gridDensity).toBe(DEFAULT_SETTINGS.gridDensity)
  })

  it('⑥ DEFAULT_SETTINGS 本身不再声明 aiClassify', () => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'aiClassify')).toBe(false)
  })

  it('⑦ 旧档写成字符串再解析（真实读档形态）同样不炸', () => {
    const text = JSON.stringify(LEGACY_RAW)
    expect(() => readLikeLoadSettings(JSON.parse(text) as unknown)).not.toThrow()
    expect(readLikeLoadSettings(JSON.parse(text) as unknown).libraryDir).toBe(
      'D:\\LegacyVault\\Library'
    )
  })
})

describe('源码守卫：AI 辅助分类已下线，且共享通道没被误删', () => {
  it('SettingsDialog.tsx 里 AI 辅助分类 / 模型兜底 / aiClassify 零命中', () => {
    const src = read('src/renderer/components/SettingsDialog.tsx')
    expect(src).not.toContain('AI 辅助分类')
    expect(src).not.toContain('模型兜底')
    expect(src).not.toContain('aiClassify')
  })

  it('src/main/aiClassify.ts（唯一 HTTP 实现）已删除', () => {
    expect(existsSync(path.join(ROOT, 'src', 'main', 'aiClassify.ts'))).toBe(false)
  })

  it('tests/aiClassify.test.ts（29 个纯逻辑单测）已删除', () => {
    expect(existsSync(path.join(ROOT, 'tests', 'aiClassify.test.ts'))).toBe(false)
  })

  it('src/shared/ipc.ts 里 aiClassify 零命中，但 import:batchDone 仍在', () => {
    const src = read('src/shared/ipc.ts')
    expect(src).not.toContain('aiClassify')
    expect(src).not.toContain('ai:classify')
    expect(src).not.toContain('ai:test')
    expect(src).toContain("importBatchDone: 'import:batchDone'")
  })

  it('import:batchDone 共享回调仍接线（store / preload / main 三处），AI 调度已摘掉', () => {
    const store = read('src/renderer/store.ts')
    expect(store).toContain('onImportBatchDone(')
    expect(store).toContain('scheduleZhimoPipeline()')
    expect(store).toContain("reportPluginSnapshot('importBatchDone')")
    expect(store).not.toContain('scheduleAiClassify')
    expect(store).not.toContain('runAiClassify')

    const preload = read('src/preload/index.ts')
    expect(preload).toContain('onImportBatchDone:')
    expect(preload).not.toContain('aiClassify')

    const main = read('src/main/index.ts')
    expect(main).toContain('IPC.importBatchDone')
    expect(main).not.toContain('aiClassify')
  })
})
