/**
 * 1.2.1 插入项 · 向导第 1 步「添加快速访问」次级入口（源码守卫，范式 homePinnedWiring）。
 *
 * 用户口径：右键添加快速访问太难发现 —— 在新建项目向导第 1 步给一条**可见**的路。
 * 点击后由 App **先关向导**再弹系统文件夹选择器（模态和系统对话框不能叠着）。
 *
 * | # | 守卫 | 防的退化 |
 * |---|------|----------|
 * | 1 | 向导可选 prop `onAddQuickAccess` + 入口文案 + 点击只调宿主 | 入口变自调 IPC / 重复触发 |
 * | 2 | App 接线：先 setNewProjectOpen(false) 再 addHomePinnedFromPicker | 模态与系统对话框叠着 |
 * | 3 | 次级样式：不做成大 CTA（安静 text-tertiary 小字） | 抢「下一步」的视觉权重 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 相对仓库根读源码，换行归一（工作区 CRLF）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释：本仓注释里就写着要防的东西，不剥会误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('向导 · 添加快速访问次级入口', () => {
  const src = stripComments(readSrc('src/renderer/components/home/NewProjectWizard.tsx'))

  it('可选 prop onAddQuickAccess 存在，且入口只透传宿主（入口块内不自调 IPC）', () => {
    expect(src).toContain('onAddQuickAccess?: () => void')
    const start = src.indexOf("typeof onAddQuickAccess === 'function'")
    expect(start).toBeGreaterThan(0)
    const entry = src.slice(start, src.indexOf(") : null}", start))
    expect(entry).toContain('onClick={onAddQuickAccess}')
    // 入口点击不直接调 IPC（由 App 关向导后统一走 addHomePinnedFromPicker）
    expect(entry).not.toContain('pickDirectory(')
    expect(entry).not.toContain('modvault.')
  })

  it('入口文案可见且带说明 + 链接式次级按钮', () => {
    expect(src).toContain('不需要新建项目？')
    expect(src).toContain('添加快速访问到首页')
  })

  it('次级样式：小字 tertiary + 分隔线，不做大 CTA（无 btn-primary / btn 类）', () => {
    const start = src.indexOf("typeof onAddQuickAccess === 'function'")
    expect(start).toBeGreaterThan(0)
    const entry = src.slice(start, src.indexOf(") : null}", start))
    expect(entry).toContain('text-tertiary')
    expect(entry).toContain('border-t')
    expect(entry).not.toContain('btn-primary')
    expect(entry, '入口按钮不得套大按钮类').not.toContain('className="btn')
  })

  it('入口只出现在第 1 步（template 块内），主流程零影响', () => {
    // 模板列表 map 结束后才出现入口，且整个入口在 step === 'template' 条件块里
    const tplIdx = src.indexOf("step === 'template' ? (")
    const entryIdx = src.indexOf("typeof onAddQuickAccess === 'function'")
    const fieldsIdx = src.indexOf("step === 'fields' ? (")
    expect(tplIdx).toBeGreaterThan(0)
    expect(entryIdx).toBeGreaterThan(tplIdx)
    expect(fieldsIdx).toBeGreaterThan(entryIdx)
  })
})

describe('App · 接线（先关向导再开系统选择器）', () => {
  it('传参顺序：setNewProjectOpen(false) 在 addHomePinnedFromPicker 之前', () => {
    const src = stripComments(readSrc('src/renderer/App.tsx'))
    const start = src.indexOf('onAddQuickAccess={() => {')
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start, src.indexOf('}}', start))
    const closeIdx = body.indexOf('setNewProjectOpen(false)')
    const pickIdx = body.indexOf('addHomePinnedFromPicker()')
    expect(closeIdx).toBeGreaterThan(0)
    expect(pickIdx).toBeGreaterThan(closeIdx)
  })

  it('onAddQuickAccess 是可选 prop：不传时入口不渲染（守卫回归锚点）', () => {
    const src = stripComments(readSrc('src/renderer/components/home/NewProjectWizard.tsx'))
    // 条件渲染：prop 缺失 → 整块不出现（typeof 守卫而非 truthy 短路）
    expect(src).toContain("typeof onAddQuickAccess === 'function'")
  })
})
