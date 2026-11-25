/**
 * T-03 · 新建项目生成器（docs/60 §4，`src/main/projectCreate.ts`）。
 *
 * 覆盖四组判据（docs/60 §4.4 / 任务卡 T-03）：
 * ① 编号空 / 已填两条分支的根名与 §2.4 表逐字一致（buildProjectPlan 纯函数级）；
 * ② 冲突场景**零落盘**（预置同名目录后调用，断言父目录条目数不变）；
 * ③ 成功场景目录树 == 归一化后模板树逐名一致、dirsCreated == 节点数；
 * ④ W6 加固：注入 10 层深 / 500 节点的脏树，实际落盘 ≤4 级 / ≤256 节点；
 * ⑤ 半程 IO 失败：不回滚、错误串如实报告已建数量（假 io 复现 —— 真实盘上
 *    无法稳定制造中途 mkdir 异常）；
 * ⑥ 盘根 / 相对路径 / 空名称 / 坏模板四个拒绝分支。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_TEMPLATES, cloneDefaultTemplates } from '../src/shared/projectTemplate'
import { buildProjectPlan, createProjectDirs, type ProjectCreateIo } from '../src/main/projectCreate'

const builtin = DEFAULT_PROJECT_TEMPLATES[0]

/** 建一个一次性父目录（用完由 afterEach 级联清理交给 os.tmpdir 策略即可，不主动删） */
function makeTempParent(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbox-project-create-'))
}

/** 统计目录下一层条目数（相对名字典序，供"零落盘"断言比对） */
function listEntries(dir: string): string[] {
  return fs.readdirSync(dir).sort()
}

/* ────────────────────────────────────────────────────────────────────────────
 * buildProjectPlan（W6 纯函数加固）
 * ──────────────────────────────────────────────────────────────────────────── */

describe('buildProjectPlan · 根名两分支（docs/60 §2.4 表逐字）', () => {
  it('编号已填 → （编号）+名称', () => {
    const plan = buildProjectPlan({
      template: builtin,
      code: '2026-018',
      name: '江畔会所',
      parentDir: 'E:\\Projects'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rootName).toBe('（2026-018）+江畔会所')
    expect(plan.rootPath).toBe(path.join('E:\\Projects', '（2026-018）+江畔会所'))
  })

  it('编号留空 → 直接用名称（忽略占位符结构）', () => {
    const plan = buildProjectPlan({
      template: builtin,
      code: '',
      name: '江畔会所',
      parentDir: 'E:\\Projects'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rootName).toBe('江畔会所')
  })

  it('纯空白编号与留空同分支；子目录名是纯字面量不被替换', () => {
    const plan = buildProjectPlan({
      template: builtin,
      code: '   ',
      name: '江畔会所',
      parentDir: 'E:\\Projects'
    })
    if (!plan.ok) throw new Error('应当成功')
    expect(plan.rootName).toBe('江畔会所')
    expect(plan.targets).toContain(path.join(plan.rootPath, '1-工作资料'))
    expect(plan.targets.some((t) => t.includes('{编号}'))).toBe(false)
  })
})

describe('buildProjectPlan · 拒绝分支（docs/60 §4.3 安全拒绝分支表）', () => {
  it('名称为空 → 拒绝', () => {
    const plan = buildProjectPlan({ template: builtin, code: '2026-018', name: '', parentDir: 'E:\\Projects' })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('项目名称')
  })

  it('模板拿不到 / 坏 → 拒绝（不抛错）', () => {
    for (const bad of [null, undefined, 'x', {}, { root: null }, { root: { name: 42 } }]) {
      const plan = buildProjectPlan({ template: bad, code: '', name: '江畔会所', parentDir: 'E:\\Projects' })
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.error).toContain('模板')
    }
  })

  it('相对路径 / 盘根 → 拒绝（目标根不允许是盘根）', () => {
    const rel = buildProjectPlan({ template: builtin, code: '', name: 'a', parentDir: 'relative/dir' })
    expect(rel.ok).toBe(false)
    const winRoot = buildProjectPlan({ template: builtin, code: '', name: 'a', parentDir: 'E:\\' })
    expect(winRoot.ok).toBe(false)
    if (!winRoot.ok) expect(winRoot.error).toContain('存放位置')
    const posixRoot = buildProjectPlan({ template: builtin, code: '', name: 'a', parentDir: '/' })
    expect(posixRoot.ok).toBe(false)
  })

  it('入参完全不是对象也永不抛错', () => {
    expect(() => buildProjectPlan(null)).not.toThrow()
    expect(() => buildProjectPlan(undefined)).not.toThrow()
    expect(() => buildProjectPlan(42)).not.toThrow()
    expect(buildProjectPlan(null).ok).toBe(false)
  })
})

describe('buildProjectPlan · W6 加固（注入脏树被剪到上限内）', () => {
  /** 10 层深、每层挂 100 个兄弟 ≈ 500+ 节点的注入树 */
  function dirtyTree(): unknown {
    const node = (depth: number): Record<string, unknown> => {
      if (depth >= 10) return { name: `L10-${depth}` }
      return {
        name: `L${depth}`,
        children: Array.from({ length: 100 }, (_, i) =>
          i === 0 ? node(depth + 1) : { name: `L${depth}-${i}` }
        )
      }
    }
    return { id: 'evil', name: '注入树', root: { name: '根', children: [node(1)] } }
  }

  it('10 层深 / 500+ 节点 → 展开后 ≤4 级 / ≤256 节点，照常生成计划', () => {
    const plan = buildProjectPlan({
      template: dirtyTree(),
      code: '2026-018',
      name: '江畔会所',
      parentDir: 'E:\\Projects'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.targets.length).toBeLessThanOrEqual(256)
    // 最深目标相对根目录的层数 ≤ 4（BFS 展开 = 树节点深度）
    const maxDepth = Math.max(
      ...plan.targets.map((t) => path.relative(plan.rootPath, t).split(path.sep).filter(Boolean).length)
    )
    expect(maxDepth).toBeLessThanOrEqual(4)
  })

  it('257+ 兄弟节点截断到 256 总节点（含根）', () => {
    const fat = {
      id: 'fat',
      name: '胖树',
      root: {
        name: '根',
        children: Array.from({ length: 300 }, (_, i) => ({ name: `c${i}` }))
      }
    }
    const plan = buildProjectPlan({ template: fat, code: '', name: 'a', parentDir: 'E:\\Projects' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.targets.length).toBe(256)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * createProjectDirs（真实临时目录：冲突零落盘 / 成功全量 / 半程失败不回滚）
 * ──────────────────────────────────────────────────────────────────────────── */

describe('createProjectDirs · 冲突整体拒绝（Q-5：零创建）', () => {
  it('根目录已存在 → 拒绝、父目录条目数不变', () => {
    const parent = makeTempParent()
    const plan = buildProjectPlan({ template: builtin, code: '2026-018', name: '江畔会所', parentDir: parent })
    if (!plan.ok) throw new Error('应当成功')
    fs.mkdirSync(plan.rootPath) // 预置同名根目录
    const before = listEntries(parent) // 基线：预置之后（= 创建过程中不得再新增任何条目）
    const result = createProjectDirs(plan)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('已存在同名文件夹')
    expect(result.dirsCreated).toBe(0)
    expect(listEntries(parent)).toEqual(before) // 零落盘
  })

  it('任一子目录已存在（残留半成品）→ 整体拒绝、零创建，错误串指到冲突目录', () => {
    const parent = makeTempParent()
    const plan = buildProjectPlan({ template: builtin, code: '', name: '江畔会所', parentDir: parent })
    if (!plan.ok) throw new Error('应当成功')
    fs.mkdirSync(path.join(plan.rootPath, '2-工作文件'), { recursive: true }) // 预置深层残留
    const before = listEntries(parent) // 基线：预置之后
    const result = createProjectDirs(plan)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 预检按先浅后深扫：根目录也随预置一起存在 → 首个冲突 = 根目录名（其下必含残留）
    expect(result.error).toContain('江畔会所')
    expect(result.dirsCreated).toBe(0)
    expect(listEntries(parent)).toEqual(before) // 连根目录都没有被再动过
  })

  it('只有深层子目录冲突（根空闲）→ 错误串指到该子目录的相对名，零创建', () => {
    const plan = buildProjectPlan({ template: builtin, code: '', name: '江畔会所', parentDir: 'E:\\Projects' })
    if (!plan.ok) throw new Error('应当成功')
    const conflictIdx = plan.targets.findIndex((t) => t.endsWith('2-工作文件'))
    expect(conflictIdx).toBeGreaterThan(0) // 一定不在根上
    let mkdirCalls = 0
    const io: ProjectCreateIo = {
      exists: (p) => p === plan.parentDir || p === plan.targets[conflictIdx], // 父目录在；只有那个深层目录已存在
      isDirectory: (p) => p === plan.parentDir,
      mkdir: () => {
        mkdirCalls += 1
      }
    }
    const result = createProjectDirs(plan, io)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('江畔会所/2-工作文件') // 相对父目录名（/ 分隔），不暴露绝对路径
    expect(result.dirsCreated).toBe(0)
    expect(mkdirCalls).toBe(0) // 整体拒绝、零创建
  })

  it('父目录不存在 → 拒绝（不创建）', () => {
    const parent = path.join(makeTempParent(), '不存在')
    const plan = buildProjectPlan({ template: builtin, code: '', name: 'a', parentDir: parent })
    if (!plan.ok) throw new Error('应当成功')
    const result = createProjectDirs(plan)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('存放位置')
    expect(fs.existsSync(parent)).toBe(false)
  })
})

describe('createProjectDirs · 成功全量（判据 ③）', () => {
  it('目录树与模板树逐名一致、dirsCreated == 节点数（编号已填分支）', () => {
    const parent = makeTempParent()
    const plan = buildProjectPlan({
      template: cloneDefaultTemplates()[0],
      code: '2026-018',
      name: '江畔会所',
      parentDir: parent
    })
    if (!plan.ok) throw new Error('应当成功')
    const result = createProjectDirs(plan)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rootPath).toBe(plan.rootPath)
    expect(result.dirsCreated).toBe(plan.targets.length)
    // 逐名核对：计划里的每个目标都真实存在
    for (const target of plan.targets) {
      expect(fs.existsSync(target), target).toBe(true)
    }
    // 抽查两级字面量子目录
    expect(fs.existsSync(path.join(plan.rootPath, '1-工作资料', '1.1-设计资料'))).toBe(true)
    expect(fs.existsSync(path.join(plan.rootPath, '2-工作文件', '2.6-成果文件'))).toBe(true)
  })
})

describe('createProjectDirs · W8 半程 IO 失败（不回滚不删除）', () => {
  /**
   * 假 io：父目录存在（阶段一第一道过），全部目标路径空闲（预检全过），
   * 第 N 次 mkdir 抛异常 —— 真实盘上无法稳定制造中途 IO 异常，只能注入。
   */
  function failingIo(parentDir: string, failAt: number, message = 'EACCES: permission denied'): ProjectCreateIo {
    let calls = 0
    return {
      exists: (p) => p === parentDir,
      isDirectory: (p) => p === parentDir,
      mkdir: (p) => {
        calls += 1
        if (calls >= failAt) {
          const err = new Error(message) as NodeJS.ErrnoException
          err.code = 'EACCES'
          throw err
        }
      }
    }
  }

  it('第 3 个目录失败 → ok:false、dirsCreated=2、错误串如实报告已建数量', () => {
    const parent = makeTempParent()
    const plan = buildProjectPlan({ template: builtin, code: '', name: 'a', parentDir: parent })
    if (!plan.ok) throw new Error('应当成功')
    const created: string[] = []
    const io = failingIo(plan.parentDir, 3)
    const realMkdir = io.mkdir
    io.mkdir = (p) => {
      realMkdir(p)
      created.push(p)
    }
    const result = createProjectDirs(plan, io)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.dirsCreated).toBe(2)
    expect(result.error).toContain('创建文件夹失败')
    expect(result.error).toContain('已完成 2 个')
    // 已建的两个被保留（不回滚），失败的那个没有被"删掉"
    expect(created.length).toBe(2)
  })

  it('ENAMETOOLONG → 错误串含「名称过长」', () => {
    const parent = makeTempParent()
    const plan = buildProjectPlan({ template: builtin, code: '', name: 'a', parentDir: parent })
    if (!plan.ok) throw new Error('应当成功')
    const io: ProjectCreateIo = {
      exists: (p) => p === plan.parentDir,
      isDirectory: (p) => p === plan.parentDir,
      mkdir: () => {
        const err = new Error('name too long') as NodeJS.ErrnoException
        err.code = 'ENAMETOOLONG'
        throw err
      }
    }
    const result = createProjectDirs(plan, io)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('名称过长')
  })
})

describe('createProjectDirs · W6 端到端（真实磁盘上验证加固）', () => {
  it('注入 10 层 / 500+ 节点脏树，真实落盘 ≤4 级 / ≤256 个目录', () => {
    const parent = makeTempParent()
    const node = (depth: number): Record<string, unknown> => {
      if (depth >= 10) return { name: `L10` }
      return {
        name: `L${depth}`,
        children: Array.from({ length: 100 }, (_, i) =>
          i === 0 ? node(depth + 1) : { name: `L${depth}-${i}` }
        )
      }
    }
    const plan = buildProjectPlan({
      template: { id: 'evil', name: '注入树', root: { name: '根', children: [node(1)] } },
      code: '',
      name: '江畔会所',
      parentDir: parent
    })
    if (!plan.ok) throw new Error('应当成功')
    const result = createProjectDirs(plan)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsCreated).toBeLessThanOrEqual(256)
    for (const target of plan.targets) {
      expect(fs.existsSync(target), target).toBe(true)
      const depth = path.relative(plan.rootPath, target).split(path.sep).filter(Boolean).length
      expect(depth).toBeLessThanOrEqual(4)
    }
  })
})
