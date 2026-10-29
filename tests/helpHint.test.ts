/**
 * 中栏顶部操作提示 `helpHintText(kind)`（2026-10-30 用户实测）。
 *
 * > 「比如我在模型里面双击卡片查看文件，这 OK。但是，如果是在模型界面、CAD 界面
 * >   或者是材质界面，为什么要提示我『HDR 是直接进预览』？这个是不是要分一下场合？」
 *
 * 根因：`App.tsx` 原来是一句**固定文案**，不管当前大类都整句照写
 * 「双击卡片查看文件（HDR 直接进预览）· 拖拽卡片可拖到建模软件」。
 * 而实际行为是分场合的（`AssetGrid.tsx` 的 `dblProps`）：
 *   `kind === 'hdri'` → `openHdrPreview`（直接预览）；其余 → `openFolderView`（文件列表）。
 * 所以非 HDR 视图里的「HDR 直接进预览」是纯噪声，HDR 视图里的「查看文件」是错的。
 *
 * 本文件两部分：
 *   ① 纯函数断言 —— 7 个 kind 各返回什么；
 *   ② 源码守卫 —— 防止文案又被写死回 `App.tsx`，以及**防止双击行为与文案脱钩**
 *      （改了一边忘了另一边，测试会红）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { KindFilter } from '../src/shared/classify'
import { helpHintText } from '../src/renderer/logic/filters'

const ENTER_PREVIEW = '直接预览'
const ENTER_FILES = '查看文件'
const DRAG = '拖拽卡片'

/** 非 HDR 的六种视图（含分组哨兵 `materialGroup`）。 */
const NON_HDRI_KINDS: KindFilter[] = ['all', 'model', 'cad', 'materialGroup', 'texture', 'material', 'other']

function read(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

const appSrc = read('../src/renderer/App.tsx')
const gridSrc = read('../src/renderer/components/AssetGrid.tsx')

// ── ① 纯函数：按视图分场合 ────────────────────────────────────
describe('helpHintText — HDR 视图', () => {
  it('双击说明是「直接预览」（HDR 双击不进文件列表）', () => {
    const text = helpHintText('hdri')
    expect(text).toContain(ENTER_PREVIEW)
    expect(text).not.toContain(ENTER_FILES)
  })

  it('完整文案与需求表一致', () => {
    expect(helpHintText('hdri')).toBe('双击卡片直接预览 · 拖拽卡片可拖到建模软件')
  })
})

describe('helpHintText — 其余视图（逐个断言）', () => {
  for (const kind of NON_HDRI_KINDS) {
    it(`kind='${kind}'：双击说明是「查看文件」，不含 HDR 预览字样`, () => {
      const text = helpHintText(kind)
      expect(text).toContain(ENTER_FILES)
      expect(text).not.toContain(ENTER_PREVIEW)
    })

    it(`kind='${kind}'：完整文案与需求表一致`, () => {
      expect(helpHintText(kind)).toBe('双击卡片查看文件 · 拖拽卡片可拖到建模软件')
    })
  }
})

describe('helpHintText — 跨视图不变量', () => {
  it('所有视图都带「拖拽卡片」（拖出提示到处都成立）', () => {
    for (const kind of ['hdri', ...NON_HDRI_KINDS] as KindFilter[]) {
      expect(helpHintText(kind)).toContain(DRAG)
    }
  })

  it('任何视图都不再出现上一版的括号补充（那是这次要消掉的噪声）', () => {
    for (const kind of ['hdri', ...NON_HDRI_KINDS] as KindFilter[]) {
      expect(helpHintText(kind)).not.toContain('HDR 直接进预览')
      expect(helpHintText(kind)).not.toContain('（')
    }
  })

  it('非法/未知输入按非 HDR 兜底，不抛（视图状态可能来自脏快照）', () => {
    // 类型层不接受，但持久化快照可能是旧版本残留值 —— 运行时必须活下来
    expect(() => helpHintText('bogus' as KindFilter)).not.toThrow()
    expect(helpHintText('bogus' as KindFilter)).toContain(ENTER_FILES)
    expect(() => helpHintText(undefined as unknown as KindFilter)).not.toThrow()
  })
})

// ── ② 源码守卫：文案只有一个来源，且与双击行为同口径 ────────────
describe('源码守卫 — 文案唯一来源', () => {
  it('App.tsx 不再硬编码整句提示', () => {
    expect(appSrc).not.toContain('HDR 直接进预览')
    expect(appSrc).not.toContain('双击卡片查看文件（')
  })

  it('App.tsx 通过 helpHintText(filters.kind) 取文案', () => {
    expect(appSrc).toContain('helpHintText(filters.kind)')
  })

  it('渲染点仍受 showHelpHint 与「非文件视图」两个条件保护', () => {
    const idx = appSrc.indexOf('helpHintText(filters.kind)')
    expect(idx).toBeGreaterThan(-1)
    const before = appSrc.slice(Math.max(0, idx - 400), idx)
    expect(before).toContain('!folderAsset && showHelpHint')
  })
})

/**
 * ★ 口径一致性守卫（本文件存在的最重要理由）
 *
 * `helpHintText` 的 `hdri` 分支不是随便分的，它对应 `AssetGrid.dblProps` 里
 * `a.kind === 'hdri'` → `openHdrPreview(a.id)` 这条唯一的行为差异。
 * 哪天有人改了双击行为（比如让 HDR 也进文件列表）却忘了改文案，
 * 或者反过来把文案改成「直接预览」但行为没变 —— 这里就会红。
 */
describe('源码守卫 — 文案与 dblProps 双击行为同口径', () => {
  it('dblProps 里 HDR 分支仍是 a.kind === \'hdri\' + openHdrPreview(a.id)', () => {
    expect(gridSrc).toContain("a.kind === 'hdri'")
    expect(gridSrc).toContain('openHdrPreview(a.id)')
  })

  it('非 HDR 分支仍走 openFolderView（文案说的「查看文件」在行为上成立）', () => {
    expect(gridSrc).toContain('openFolderView(a.id)')
  })

  it('两个分支在同一个判断块内：HDR 分支 return，不会 fallthrough 到 openFolderView', () => {
    const hdrAt = gridSrc.indexOf("if (a.kind === 'hdri') {")
    expect(hdrAt).toBeGreaterThan(-1)
    const block = gridSrc.slice(hdrAt, hdrAt + 200)
    expect(block).toContain('openHdrPreview(a.id)')
    expect(block).toContain('return')
  })
})
