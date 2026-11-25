/**
 * 钉选目录浏览器 v2 · 归档/写操作纯逻辑 + 守卫拼装单测（docs/61 §批注结果 · 方案二）。
 *
 * 覆盖：
 *   ① `validateEntryName` 拒绝式校验真值表（非法字符 / 控制字符 / 保留名 / 中文名放行）；
 *   ② 压缩包扩展名识别与主名推导（含 `.tar.gz` 复合扩展名）；
 *   ③ 解压目标目录名 / 压缩输出 zip 名推导（固定时钟注入）；
 *   ④ 7z / PowerShell 命令拼装（含空格 / 中文 / 单引号路径的引号口径）；
 *   ⑤ `resolveEntryPath` 守卫拼装：越界 relPath / `..` 穿越 / 绝对路径 /
 *      名字带分隔符全拒（复用 `tests/pinnedDirGuard.test.ts` 的真值表风格）；
 *   ⑥ `readDirEntries` 的 `truncated` 截断标志（docs/61 A14「2000 截断明示」）。
 *
 * 测试范式：vitest node 环境（纯函数不 import React / DOM / electron）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  archiveBaseName,
  buildPowerShellCompressCommand,
  buildSevenZipCompressArgs,
  buildSevenZipExtractArgs,
  deriveExtractDirName,
  deriveZipName,
  isArchiveName,
  resolveEntryPath,
  validateEntryName
} from '../src/main/archiveOps'
import { readDirEntries } from '../src/main/pinnedDirGuard'

const isWin = process.platform === 'win32'

function makeTempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'idbox-arch-'))
}

// ── ① 条目名校验 ────────────────────────────────────────────────

describe('validateEntryName · 拒绝式校验', () => {
  it('中文名 / 常规名放行', () => {
    expect(validateEntryName('材质库')).toBeNull()
    expect(validateEntryName('Bricks 2024')).toBeNull()
    expect(validateEntryName('a.b.c')).toBeNull()
    expect(validateEntryName('模型_v2-最终')).toBeNull()
  })

  it('空 / 非字符串 → 拒', () => {
    expect(validateEntryName('')).not.toBeNull()
    expect(validateEntryName('   ')).not.toBeNull()
    expect(validateEntryName(undefined)).not.toBeNull()
    expect(validateEntryName(42)).not.toBeNull()
  })

  it('路径分隔符与 Windows 非法字符 → 拒（写通道唯一的名字注入面）', () => {
    expect(validateEntryName('a/b')).not.toBeNull()
    expect(validateEntryName('a\\b')).not.toBeNull()
    expect(validateEntryName('a:b')).not.toBeNull()
    expect(validateEntryName('a*b')).not.toBeNull()
    expect(validateEntryName('a?b')).not.toBeNull()
    expect(validateEntryName('a"b')).not.toBeNull()
    expect(validateEntryName('a<b')).not.toBeNull()
    expect(validateEntryName('a>b')).not.toBeNull()
    expect(validateEntryName('a|b')).not.toBeNull()
  })

  it("`.` / `..` / 控制字符 / NUL → 拒", () => {
    expect(validateEntryName('.')).not.toBeNull()
    expect(validateEntryName('..')).not.toBeNull()
    expect(validateEntryName('a\0b')).not.toBeNull()
    expect(validateEntryName('a\u0007b')).not.toBeNull()
  })

  it('首尾空白 / 尾点尾空格 / 保留设备名 → 拒（Windows 会静默剥，宁拒勿偏）', () => {
    expect(validateEntryName(' x')).not.toBeNull()
    expect(validateEntryName('x ')).not.toBeNull()
    expect(validateEntryName('x.')).not.toBeNull()
    expect(validateEntryName('CON')).not.toBeNull()
    expect(validateEntryName('con.txt')).not.toBeNull()
    expect(validateEntryName('COM1')).not.toBeNull()
    expect(validateEntryName('LPT9.bak')).not.toBeNull()
  })
})

// ── ② 扩展名识别与主名 ─────────────────────────────────────────

describe('isArchiveName / archiveBaseName · 扩展名识别', () => {
  it('常规压缩包扩展名（大小写不敏感）', () => {
    expect(isArchiveName('a.zip')).toBe(true)
    expect(isArchiveName('A.ZIP')).toBe(true)
    expect(isArchiveName('包.rar')).toBe(true)
    expect(isArchiveName('scene.7z')).toBe(true)
    expect(isArchiveName('x.tar')).toBe(true)
    expect(isArchiveName('y.tgz')).toBe(true)
    expect(isArchiveName('z.gz')).toBe(true)
    expect(isArchiveName('w.bz2')).toBe(true)
    expect(isArchiveName('v.xz')).toBe(true)
  })

  it('非压缩包 / 无扩展名 → false（`.zip` 整名被 path.extname 视为无扩展名；列表本就跳过隐藏条目）', () => {
    expect(isArchiveName('a.max')).toBe(false)
    expect(isArchiveName('noext')).toBe(false)
    expect(isArchiveName('.zip')).toBe(false)
    expect(isArchiveName('')).toBe(false)
    expect(isArchiveName(undefined)).toBe(false)
  })

  it('主名推导：复合扩展名一次剥净', () => {
    expect(archiveBaseName('foo.zip')).toBe('foo')
    expect(archiveBaseName('foo.tar.gz')).toBe('foo')
    expect(archiveBaseName('中文名.tar.bz2')).toBe('中文名')
    expect(archiveBaseName('foo.7z')).toBe('foo')
    expect(archiveBaseName('plain')).toBe('plain')
  })
})

// ── ③ 名字推导 ─────────────────────────────────────────────────

describe('deriveExtractDirName / deriveZipName · 目标名推导', () => {
  it('解压目录名 = 主名；剥尾部点空格；兜底名仍合法（`.zip` 整名 path.extname 视为无扩展名，直接当目录名）', () => {
    expect(deriveExtractDirName('foo.zip')).toBe('foo')
    expect(deriveExtractDirName('材质包.tar.gz')).toBe('材质包')
    expect(deriveExtractDirName('foo..zip')).toBe('foo')
    expect(deriveExtractDirName('.zip')).toBe('.zip')
    expect(validateEntryName(deriveExtractDirName('.zip'))).toBeNull()
  })

  it('压缩输出名：单目录 → 原名；单文件 → 主名；多条目 → 归档 + 时间戳（固定时钟）', () => {
    const now = new Date(2026, 10, 25, 9, 7) // 2026-11-25 09:07 本地时间
    expect(deriveZipName(['我的材质库'], now)).toBe('我的材质库.zip')
    expect(deriveZipName(['model.max'], now)).toBe('model.zip')
    expect(deriveZipName(['a.txt', 'b.txt'], now)).toBe('归档 2026-11-25 0907.zip')
    // `.max` 整名 path.extname 视为无扩展名 → 主名就是原名（合法名，照常推导）
    expect(deriveZipName(['.max'], now)).toBe('.max.zip')
    // 主名剥空（`foo..zip` 剥完只剩点）→ 兜底时间名
    expect(deriveZipName(['foo..zip'], now)).toBe('归档 2026-11-25 0907.zip')
  })
})

// ── ④ 命令拼装 ─────────────────────────────────────────────────

describe('命令拼装 · 7z 与 PowerShell', () => {
  it('7z 解压参数：-o 输出目录 + `--` 挡以 - 开头的文件名', () => {
    expect(buildSevenZipExtractArgs('E:/src/a.zip', 'E:/dest/a')).toEqual([
      'x', '-y', '-oE:/dest/a', '--', 'E:/src/a.zip'
    ])
  })

  it('7z 压缩参数：-tzip + 目标在前、源在后', () => {
    expect(buildSevenZipCompressArgs(['E:/d/a', 'E:/d/b'], 'E:/d/归档.zip')).toEqual([
      'a', '-tzip', '-y', '--', 'E:/d/归档.zip', 'E:/d/a', 'E:/d/b'
    ])
  })

  it('PowerShell 命令：单引号字面量 + -LiteralPath + 内嵌单引号翻倍', () => {
    const cmd = buildPowerShellCompressCommand(
      ['E:/我的 材料/a.b', "E:/it's/x"],
      'E:/out 归档.zip'
    )
    expect(cmd).toContain('-LiteralPath')
    expect(cmd).toContain(`'E:/我的 材料/a.b'`)
    expect(cmd).toContain(`'E:/it''s/x'`)
    expect(cmd).toContain(`-DestinationPath 'E:/out 归档.zip'`)
  })
})

// ── ⑤ 守卫拼装（写通道）───────────────────────────────────────

describe('resolveEntryPath · pin 根 + dirRel + 单段名守卫', () => {
  it('合法子路径 + 合法名 → 放行，拼出根内绝对路径', () => {
    const root = makeTempRoot()
    try {
      const r = resolveEntryPath(root, 'sub', '新文件夹')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(path.normalize(r.absPath)).toBe(path.normalize(path.join(root, 'sub', '新文件夹')))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('`..` 越界 → 拒', () => {
    const root = makeTempRoot()
    try {
      expect(resolveEntryPath(root, '..', 'x').ok).toBe(false)
      expect(resolveEntryPath(root, 'a/../../outside', 'x').ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('relPath 塞绝对路径 → 拒', () => {
    const root = makeTempRoot()
    try {
      const absolute = isWin ? os.tmpdir() : '/etc'
      expect(resolveEntryPath(root, absolute, 'x').ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('名字带路径分隔符 → 拒（防借 name 逃出 dirRel）', () => {
    const root = makeTempRoot()
    try {
      expect(resolveEntryPath(root, '', 'a/b').ok).toBe(false)
      expect(resolveEntryPath(root, '', 'a\\b').ok).toBe(false)
      expect(resolveEntryPath(root, '', '..').ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('根不是绝对路径（settings 脏数据）→ 拒', () => {
    expect(resolveEntryPath('relative/dir', '', 'x').ok).toBe(false)
  })
})

// ── ⑥ truncated 截断标志（docs/61 A14）────────────────────────

describe('readDirEntries · truncated 截断明示', () => {
  it('未超上限 → truncated:false', () => {
    const root = makeTempRoot()
    try {
      writeFileSync(path.join(root, 'a.txt'), 'a')
      writeFileSync(path.join(root, 'b.txt'), 'b')
      const r = readDirEntries(root, 3)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.entries).toHaveLength(2)
        expect(r.truncated).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('超上限 → 截到上限且 truncated:true（隐藏条目不计入判定口径）', () => {
    const root = makeTempRoot()
    try {
      writeFileSync(path.join(root, '.hidden'), 'x')
      for (let i = 0; i < 5; i += 1) writeFileSync(path.join(root, `f${i}.txt`), 'x')
      const r = readDirEntries(root, 3)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.entries).toHaveLength(3)
        expect(r.truncated).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('恰好等于上限 → truncated:false', () => {
    const root = makeTempRoot()
    try {
      for (let i = 0; i < 3; i += 1) writeFileSync(path.join(root, `f${i}.txt`), 'x')
      const r = readDirEntries(root, 3)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// 返回形状契约：ok 分支必须带 truncated（FsListDirResult 与 pinnedDirGuard 双侧同形）
describe('readDirEntries · 返回形状契约', () => {
  it('ok 分支带 truncated，条目形状与 fs:listDir 一致（目录在前）', () => {
    const root = makeTempRoot()
    try {
      mkdirSync(path.join(root, 'd'))
      writeFileSync(path.join(root, 'f.txt'), 'x')
      const r = readDirEntries(root)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(typeof r.truncated).toBe('boolean')
        expect(r.truncated).toBe(false)
        expect(r.entries.map((e) => e.name)).toEqual(['d', 'f.txt'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
