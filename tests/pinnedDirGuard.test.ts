/**
 * 钉选目录应用内浏览的**路径守卫 + 只读列目录**纯逻辑单测（v1.2 反馈批 B，
 * `src/main/pinnedDirGuard.ts`）。
 *
 * 覆盖三组：
 *   ① `resolveWithinPinRoot` 前缀校验真值表：合法子路径 / relPath 注入 / `..` 穿越 /
 *      盘符切换 / NUL / 相对根 / 大小写（Windows 不敏感）；
 *   ② `readDirEntries`：跳隐藏与软链、目录在前、大小与修改时间、条目数硬上限、
 *      目录读不了的错误收口（tmpdir 真盘验证）；
 *   ③ `LIST_DIR_MAX_ENTRIES` 常量契约（渲染层 UI 不翻页，超限即截断）。
 *
 * 测试范式：vitest node 环境（纯函数不 import React / DOM / electron）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIST_DIR_MAX_ENTRIES, readDirEntries, resolveWithinPinRoot } from '../src/main/pinnedDirGuard'

const isWin = process.platform === 'win32'

/** 造一个临时的"钉选根"（含一个子目录），测试结束清理 */
function makeTempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'idbox-pin-'))
}

describe('resolveWithinPinRoot · 前缀校验真值表', () => {
  it('空 relPath = 根本身', () => {
    const root = makeTempRoot()
    try {
      const r = resolveWithinPinRoot(root, '')
      expect(r.ok).toBe(true)
      if (r.ok) expect(path.normalize(r.absPath)).toBe(path.normalize(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("'.' 与普通子段都在根内", () => {
    const root = makeTempRoot()
    try {
      const self = resolveWithinPinRoot(root, '.')
      expect(self.ok).toBe(true)
      const sub = resolveWithinPinRoot(root, 'sub')
      expect(sub.ok).toBe(true)
      if (sub.ok) {
        expect(path.normalize(sub.absPath)).toBe(path.normalize(path.join(root, 'sub')))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('根内的 ../ 折返仍放行（resolve 后落在根内即可）', () => {
    const root = makeTempRoot()
    try {
      const r = resolveWithinPinRoot(root, 'a/b/../c')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(path.normalize(r.absPath)).toBe(path.normalize(path.join(root, 'a', 'c')))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('父级目录（根的兄弟 / 上级）不得冒充子路径（整段前缀）', () => {
    const root = makeTempRoot()
    try {
      // 以 <tmp>/a 为根，relPath '..' resolve 到 <tmp>（根的父级）→ 拒；
      // 同理任何以 <tmp>/a 为"前缀字面量"的兄弟目录（<tmp>/ab）都必须经 '..' 折返才可达，
      // 而折返后的路径不满足整段前缀（'ab' 不以 'a' + 分隔符开头）。
      expect(resolveWithinPinRoot(path.join(root, 'a'), '..').ok).toBe(false)
      expect(resolveWithinPinRoot(path.join(root, 'a'), '../ab').ok).toBe(false)
      expect(resolveWithinPinRoot(path.join(root, 'a'), '../ab/x').ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('`..` 越出根 → 拒', () => {
    const root = makeTempRoot()
    try {
      expect(resolveWithinPinRoot(root, '..').ok).toBe(false)
      expect(resolveWithinPinRoot(root, 'sub/../../outside').ok).toBe(false)
      expect(resolveWithinPinRoot(root, '..\\..\\outside').ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('relPath 塞绝对路径 → 拒（resolve 直接跳走，前缀失败）', () => {
    const root = makeTempRoot()
    try {
      const absolute = isWin ? os.tmpdir() : '/etc'
      expect(resolveWithinPinRoot(root, absolute).ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('盘符切换（Windows）→ 拒', () => {
    if (!isWin) return
    const root = makeTempRoot()
    try {
      // 另一个盘符（存在与否不影响 resolve 结果；前缀比较必然失败）
      expect(resolveWithinPinRoot(root, 'Q:\\outside\\x').ok).toBe(false)
      expect(resolveWithinPinRoot(root, 'q:/outside').ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('NUL 字节 / 非字符串 relPath → 拒', () => {
    const root = makeTempRoot()
    try {
      expect(resolveWithinPinRoot(root, 'a\0b').ok).toBe(false)
      expect((resolveWithinPinRoot(root, undefined as unknown as string) as { ok: boolean }).ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('根不是绝对路径 → 拒（防 settings 脏数据直通）', () => {
    expect(resolveWithinPinRoot('relative/dir', 'x').ok).toBe(false)
    expect(resolveWithinPinRoot('', 'x').ok).toBe(false)
  })

  it('Windows：路径比较大小写不敏感（同一目录换写法仍放行）', () => {
    if (!isWin) return
    const root = makeTempRoot().toUpperCase()
    try {
      const r = resolveWithinPinRoot(root.toLowerCase(), 'SUB')
      expect(r.ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('readDirEntries · 只读列一层条目', () => {
  it('跳过隐藏条目；目录在前、文件在后，同组按名称排序；文件带 size / mtimeMs', () => {
    const root = makeTempRoot()
    try {
      writeFileSync(path.join(root, '.hidden'), 'x')
      writeFileSync(path.join(root, '.gitkeep'), '')
      writeFileSync(path.join(root, 'b.txt'), 'bb')
      writeFileSync(path.join(root, 'a.txt'), 'a')
      mkdirSync(path.join(root, 'subB'))
      mkdirSync(path.join(root, 'subA'))
      const r = readDirEntries(root)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const names = r.entries.map((e) => e.name)
      expect(names).not.toContain('.hidden')
      expect(names).not.toContain('.gitkeep')
      // 目录在前（subA/subB），文件在后（a.txt/b.txt），同组按名称升序。
      // （排序用 localeCompare；CJK 与 ASCII 的相互次序是 ICU 口径，断言只用 ASCII 名
      //   避免跨环境 ICU 差异，中文目录名在渲染层展示不受影响。）
      expect(names.filter((n) => n.startsWith('sub'))).toEqual(['subA', 'subB'])
      expect(names.filter((n) => !n.startsWith('sub'))).toEqual(['a.txt', 'b.txt'])
      const file = r.entries.find((e) => e.name === 'a.txt')
      expect(file?.isDir).toBe(false)
      expect(file?.size).toBe(1)
      expect(typeof file?.mtimeMs).toBe('number')
      const dir = r.entries.find((e) => e.name === 'subA')
      expect(dir?.isDir).toBe(true)
      expect(dir?.size).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('跳过符号链接（防借软链越界）', () => {
    const root = makeTempRoot()
    try {
      mkdirSync(path.join(root, 'real'))
      writeFileSync(path.join(root, 'real', 'inside.txt'), 'x')
      const link = path.join(root, 'link')
      try {
        symlinkSync(path.join(root, 'real'), link, isWin ? 'junction' : 'dir')
      } catch {
        // Windows 无符号链接权限的环境跳过本例（junction 已尽量绕开权限）
        if (isWin) return
        throw new Error('symlink 创建失败')
      }
      const r = readDirEntries(root)
      if (!r.ok) return
      expect(r.entries.map((e) => e.name)).toEqual(['real'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('条目数硬上限：超过 maxEntries 截断（防炸口径）', () => {
    const root = makeTempRoot()
    try {
      for (let i = 0; i < 5; i += 1) writeFileSync(path.join(root, `f${i}.txt`), 'x')
      const r = readDirEntries(root, 3)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.entries).toHaveLength(3)
      expect(r.entries.every((e) => !e.isDir)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目录读不了（不存在）→ {ok:false, error:中文单行}，不抛错', () => {
    const r = readDirEntries(path.join(makeTempRoot(), 'gone'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0)
      expect(r.error).not.toMatch(/[\r\n]/)
    }
  })

  it('LIST_DIR_MAX_ENTRIES = 2000（契约常量，渲染层 UI 不给翻页）', () => {
    expect(LIST_DIR_MAX_ENTRIES).toBe(2000)
  })
})

describe('pinnedDirGuard 模块卫生', () => {
  it('只读纪律：模块内不出现任何写入 / 删除 / 链接类 API', () => {
    const guardSrc = readFileSync(
      path.resolve(__dirname, '../src/main/pinnedDirGuard.ts'),
      'utf-8'
    )
    expect(guardSrc).not.toMatch(/writeFile|appendFile|mkdir|rmdir|unlink|rename\(|chmod/)
    expect(guardSrc).toMatch(/readdirSync/)
    expect(guardSrc).toMatch(/statSync/)
  })
})
