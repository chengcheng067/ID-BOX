/**
 * 「材质大类合并」链路接线守卫（docs/14 §2.1 #13 / §9 RM1）。
 *
 * 这是本次变更**最高危**的一条：`kindFolder` 改成返回「材质」后，如果主进程
 * `asset:assignCategory` 的安全门仍用 `Object.values(KIND_LABEL)`（显示名）做白名单，
 * 「材质」会被判非法 → `assignCategory` 返回 null → **指派分类静默失效**（不报错、不移动）。
 *
 * 两条互补的守卫：
 * 1. **行为守卫**：对全部 6 个 `AssetKind`，`isKindFolderName(kindFolder(kind))` 必须为 true
 *    —— 渲染层实际传的就是 `kindFolder(asset.kind)`，这条直接证明安全门不会拦。
 * 2. **源码守卫**：`src/main/index.ts` 不得再出现 `Object.values(KIND_LABEL)`，
 *    且必须调用 `isKindFolderName`（防未来有人"顺手改回去"，编译期不会发现）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  KIND_FOLDER,
  KIND_LABEL,
  isKindFolderName,
  kindFolder,
  kindFromFolderName
} from '../src/shared/classify'
import type { AssetKind } from '../src/shared/types'

// 2026-10-29 加 `'cad'`：五元 → 六元。**必须逐个列全**（不是在运行期从 KIND_FOLDER 取键）——
// 这张表的用途正是"少一个大类就红"，自己派生出来就失去意义了。
const ALL_KINDS: AssetKind[] = ['model', 'texture', 'hdri', 'material', 'cad', 'other']

describe('assignCategory 安全门接线守卫', () => {
  it('★渲染层传的值 = kindFolder(kind) → 必须被 isKindFolderName 接受（全部 6 个 kind）', () => {
    for (const kind of ALL_KINDS) {
      const name = kindFolder(kind)
      expect(name.length).toBeGreaterThan(0)
      expect(isKindFolderName(name)).toBe(true)
    }
  })

  it('★贴图 / 材质预设 落盘「材质」也过安全门（合并前会返回 null 的那两个）', () => {
    expect(kindFolder('texture')).toBe('材质')
    expect(kindFolder('material')).toBe('材质')
    expect(isKindFolderName('材质')).toBe(true)
    // 反向证明：旧的显示名白名单 `Object.values(KIND_LABEL)` 里**没有**「材质」
    // → 若不改安全门，assignCategory 必定返回 null（静默失效）
    expect(Object.values(KIND_LABEL)).not.toContain('材质')
  })

  it('KIND_FOLDER 的值全部合法；KIND_LABEL 里独有的值不再被当作合法目录名', () => {
    for (const folder of Object.values(KIND_FOLDER)) {
      expect(isKindFolderName(folder)).toBe(true)
    }
    // 「贴图」是历史别名（只读兼容），仍放行；但显示名不是路径白名单的来源
    expect(isKindFolderName(KIND_LABEL.texture)).toBe(true) // '贴图' —— 历史别名
    expect(isKindFolderName(KIND_LABEL.material)).toBe(true) // '材质预设' —— 历史别名
  })

  it('反解与落盘互为逆运算（有歧义的「材质」除外）', () => {
    for (const kind of ALL_KINDS) {
      const folder = kindFolder(kind)
      const back = kindFromFolderName(folder)
      if (folder === '材质') {
        expect(back).toBeNull() // 两类共用，无法唯一反解
      } else {
        expect(back).toBe(kind)
      }
    }
  })

  it('src/main/index.ts 不再用 KIND_LABEL 做路径白名单，且改用 isKindFolderName', () => {
    // ESM（package.json `type: module`）下没有 __dirname，用 import.meta.url 定位源文件
    const srcPath = new URL('../src/main/index.ts', import.meta.url)
    const src = fs.readFileSync(srcPath, 'utf-8')
    expect(src).not.toContain('Object.values(KIND_LABEL)')
    expect(src).toContain('isKindFolderName')
    // 安全门的判定必须来自共享表（不得在 main 里另抄一份目录名字面量）
    expect(src).toMatch(/kindFolderNameOf[\s\S]{0,200}isKindFolderName\(/)
  })
})
