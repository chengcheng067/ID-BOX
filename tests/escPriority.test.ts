/// <reference lib="dom" />
/**
 * 全局 Esc 的优先级纯函数（0.7.6 T-ESC）。
 *
 * 修的是 `App.tsx` 原来的连带缺陷：Esc 分支尾部**无条件** `select(null)` +
 * `setSettingsOpen(false)`，只对三个状态让过路。于是「开着批量重命名按 Esc」
 * 会先清空选中（右侧面板卸载、`renameIds` 还在 → 弹窗悬空留在空面板上）。
 */
import { describe, expect, it } from 'vitest'
import { decideEsc, type EscContext } from '../src/renderer/logic/escPriority'

/** 全部关着的基线：只有这两项是"默认就可能为真"的 */
const IDLE: EscContext = {
  modalOpen: false,
  hdrPreviewOpen: false,
  pendingDelete: false,
  renameOpen: false,
  categoryPickerOpen: false,
  settingsOpen: false,
  folderViewOpen: false,
  hasSelection: false
}

describe('decideEsc：栈顶优先', () => {
  it('同时有选中项 + 批量重命名：只关弹窗，不清选中', () => {
    expect(decideEsc({ ...IDLE, renameOpen: true, hasSelection: true })).toBe('close-rename')
  })

  it('什么都没开、有选中项：才清选中', () => {
    expect(decideEsc({ ...IDLE, hasSelection: true })).toBe('clear-selection')
  })

  it('什么都没开、也没选中项：一个字都不做', () => {
    expect(decideEsc(IDLE)).toBe('none')
  })

  it('删除确认优先于清选中（不可逆方向先撤销）', () => {
    expect(decideEsc({ ...IDLE, pendingDelete: true, hasSelection: true })).toBe('undo-delete')
  })

  it('HDR 预览自己吃 Esc，App 让路（否则会顺手清掉下面的选中）', () => {
    expect(decideEsc({ ...IDLE, hdrPreviewOpen: true, hasSelection: true })).toBe('none')
  })

  it('文件视图：Esc 退回网格，选中态保留', () => {
    expect(decideEsc({ ...IDLE, folderViewOpen: true, hasSelection: true })).toBe('close-folder-view')
  })

  it('弹窗层在场时 App 一律不动（Modal 已在捕获阶段处理，双保险）', () => {
    const ctx: EscContext = {
      ...IDLE,
      modalOpen: true,
      renameOpen: true,
      categoryPickerOpen: true,
      settingsOpen: true,
      folderViewOpen: true,
      hasSelection: true
    }
    expect(decideEsc(ctx)).toBe('none')
  })

  it('分类选择器 / 设置弹窗各有独立动作（Modal 未挂载的窗口期也不清选中）', () => {
    expect(decideEsc({ ...IDLE, categoryPickerOpen: true, hasSelection: true })).toBe(
      'close-category-picker'
    )
    expect(decideEsc({ ...IDLE, settingsOpen: true, hasSelection: true })).toBe('close-settings')
  })

  it('优先级顺序：删除确认 > 重命名 > 分类 > 设置 > 文件视图 > 清选中', () => {
    const all: EscContext = {
      modalOpen: false,
      hdrPreviewOpen: false,
      pendingDelete: true,
      renameOpen: true,
      categoryPickerOpen: true,
      settingsOpen: true,
      folderViewOpen: true,
      hasSelection: true
    }
    expect(decideEsc(all)).toBe('undo-delete')
    expect(decideEsc({ ...all, pendingDelete: false })).toBe('close-rename')
    expect(decideEsc({ ...all, pendingDelete: false, renameOpen: false })).toBe(
      'close-category-picker'
    )
    expect(
      decideEsc({ ...all, pendingDelete: false, renameOpen: false, categoryPickerOpen: false })
    ).toBe('close-settings')
    expect(
      decideEsc({
        ...all,
        pendingDelete: false,
        renameOpen: false,
        categoryPickerOpen: false,
        settingsOpen: false
      })
    ).toBe('close-folder-view')
  })
})
