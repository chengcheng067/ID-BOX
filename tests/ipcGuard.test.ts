/**
 * 破坏性 / 可执行 IPC 通道的边界守卫单测（`src/main/ipcGuard.ts`）。
 *
 * 只测纯函数：Electron 的 `shell.*` 调用与 IPC 接线不在 node 测试环境里跑。
 * 用例全部**表驱动**，因为这里要钉死的是一组"边界真值表"——每加一条都想让
 * 下一个人一眼看出"哪个路径算库内、哪个算危险"。
 *
 * 路径一律写成 Windows 形态（`C:\lib\…`）：ID BOX 只发 Windows 包，
 * 且 `ipcGuard` 内部把分隔符统一后再走 `path.posix.normalize`，
 * 因此这些用例在任何 CI 平台上都是同一结果。
 */
import { describe, expect, it } from 'vitest'
import { guardOpenPaths, guardTrashPaths, isWithinRoot } from '../src/main/ipcGuard'

/** 测试用库根（与真实设置里的 `settings.libraryDir` 同形状） */
const LIB = 'C:\\lib'
/** 测试用日志目录（`<userData>/logs`，在库根**外**） */
const LOG = 'C:\\Users\\u\\AppData\\Roaming\\idbox\\logs'

// ── isWithinRoot ────────────────────────────────────────────────────────

describe('isWithinRoot', () => {
  /** [root, target, 期望, 说明] */
  const CASES: Array<[string, string, boolean, string]> = [
    // 基本包含
    [LIB, 'C:\\lib\\模型\\椅子\\酒店\\椅子_01', true, '深层资产目录'],
    [LIB, 'C:\\lib\\a.skp', true, '直接子文件'],
    [LIB, LIB, true, '等于根 → 允许（reveal(libraryDir)）'],
    [LIB, 'C:\\lib\\', true, '训练：末尾带分隔符 = 根自身'],
    [LIB, 'C:\\lib\\\\模型', true, '重复分隔符照常归一'],
    [LIB, 'C:/lib/模型', true, '前斜杠混杂'],
    // 前缀陷阱：必须带分隔符比较
    [LIB, 'C:\\lib2\\x', false, '同前缀不同目录（lib vs lib2）'],
    [LIB, 'C:\\library', false, '同前缀不同目录（lib vs library）'],
    [LIB, 'C:\\li', false, '父目录前缀'],
    // 穿越
    [LIB, 'C:\\lib\\..\\evil\\x', false, '.. 穿越出根'],
    [LIB, 'C:\\lib\\sub\\..\\..\\evil', false, '多级 .. 穿越出根'],
    [LIB, 'C:\\lib\\..\\lib2\\x', false, '穿越到同前缀兄弟目录'],
    [LIB, 'C:\\lib\\..\\lib\\x', true, '.. 后又回到根内 → 允许（归一后仍在根内）'],
    // 大小写（Windows 语义）
    [LIB, 'c:\\LIB\\模型', true, '大小写不同但同目录'],
    ['c:\\LIB', 'C:\\lib\\模型', true, '根侧大小写不同'],
    [LIB, 'C:\\LIB2\\x', false, '大小写不同且确实是另一个目录'],
    // 根外
    [LIB, 'D:\\lib\\x', false, '不同盘符'],
    [LIB, 'C:\\other', false, '完全无关目录'],
    [LIB, LOG, false, '日志目录不在库根内（由调用方作为额外根传入）'],
    // 相对 / 空 / 畸形
    [LIB, 'lib\\x', false, '相对路径'],
    [LIB, '.', false, '当前目录'],
    [LIB, '..', false, '上级目录'],
    [LIB, '', false, '空串'],
    ['', 'C:\\lib\\x', false, '空根'],
    ['', '', false, '双空'],
    [LIB, '\\lib\\x', false, '盘符相对（\\ 开头）不算绝对'],
    [LIB, 'C:lib\\x', false, '盘符相对（无分隔符）不算绝对'],
    // 根自身是文件系统根 → 无法做包含判定，deny by default
    ['/', '/home/u/x', false, '根为 / 时拒绝（根缺乏可比较的边界）'],
    // POSIX 形态（Linux/macOS 上的 userData）
    ['/home/u/lib', '/home/u/lib/x', true, 'POSIX 包含'],
    ['/home/u/lib', '/home/u/lib2', false, 'POSIX 前缀陷阱'],
    ['/home/u/lib/', '/home/u/lib/x', true, 'POSIX 根带尾分隔符'],
    // UNC
    ['\\\\srv\\share\\lib', '\\\\srv\\share\\lib\\x', true, 'UNC 包含'],
    ['\\\\srv\\share\\lib', '\\\\srv\\share\\other\\x', false, 'UNC 根外']
  ]

  for (const [root, target, expected, label] of CASES) {
    it(`${label}：${JSON.stringify(target)} → ${expected}`, () => {
      expect(isWithinRoot(root, target)).toBe(expected)
    })
  }

  it('非字符串入参一律 false 且不抛', () => {
    const BAD: unknown[] = [null, undefined, 123, 0, {}, [], true, false, () => 'C:\\lib\\x']
    for (const bad of BAD) {
      // 生产里这些值是 IPC 原始入参强转进来的，运行期必须自己挡
      expect(isWithinRoot(LIB, bad as string)).toBe(false)
      expect(isWithinRoot(bad as string, 'C:\\lib\\x')).toBe(false)
      expect(isWithinRoot(bad as string, bad as string)).toBe(false)
    }
  })
})

// ── guardOpenPaths ──────────────────────────────────────────────────────

describe('guardOpenPaths', () => {
  const ROOTS = [LIB, LOG]

  /** [raw, 期望 ok, 说明] */
  const CASES: Array<[unknown, string[], string]> = [
    ['C:\\lib\\模型\\椅子\\a.skp', ['C:\\lib\\模型\\椅子\\a.skp'], '库内文件（AssetGrid / DetailPanel）'],
    ['C:\\lib', ['C:\\lib'], '库根本身（reveal(libraryDir)）'],
    // 这一条是必须保留的功能：设置页「打开日志文件夹」
    [LOG, [LOG], '日志目录（SettingsDialog → openPath(logStat.dir)）'],
    ['C:\\lib\\logs\\app-2026-10-13.log', ['C:\\lib\\logs\\app-2026-10-13.log'], '日志目录内文件'],
    ['C:\\Windows\\System32\\calc.exe', [], '库外可执行文件 → 拒'],
    ['C:\\lib2\\x', [], '同前缀兄弟目录 → 拒'],
    ['C:\\lib\\..\\evil', [], '穿越出根 → 拒'],
    ['D:\\工作\\图纸', [], '库外目录 → 拒'],
    ['lib\\x', [], '相对路径 → 拒'],
    ['', [], '空串 → 拒'],
    [null, [], 'null → 拒'],
    [undefined, [], 'undefined → 拒'],
    [123, [], 'number → 拒'],
    [{}, [], 'object → 拒'],
    // 数组入参（不正常调用）：逐个判定，不抛；通过的照常放行
    [['C:\\lib\\a.skp', 'C:\\evil\\b.exe'], ['C:\\lib\\a.skp'], '数组中部分通过'],
    [[], [], '空数组 → 全空'],
    [[null, 42], [], '数组内非字符串成员 → 全拒不抛']
  ]

  for (const [raw, expectedOk, label] of CASES) {
    it(`${label}`, () => {
      const r = guardOpenPaths(raw, ROOTS)
      expect(r.ok).toEqual(expectedOk)
      // 每个入参要么被放行要么被拒，不允许"消失"
      const candidateCount = Array.isArray(raw) ? raw.length : 1
      expect(r.ok.length + r.rejected.length).toBe(candidateCount)
    })
  }

  it('被拒项的 rejected 保留原始字符串（供日志对账）', () => {
    const r = guardOpenPaths('C:\\Windows\\notepad.exe', ROOTS)
    expect(r.ok).toEqual([])
    expect(r.rejected).toEqual(['C:\\Windows\\notepad.exe'])
  })

  it('非字符串被拒项给出可读标签，且 String() 会抛的对象也不抛', () => {
    const noProto = Object.create(null) as object
    const r = guardOpenPaths([undefined, null, 7, noProto], ROOTS)
    expect(r.ok).toEqual([])
    expect(r.rejected).toEqual(['undefined', 'null', '7', '[unprintable]'])
  })

  it('roots 为空 / 非数组 / 含非字符串项时不抛，且一律拒', () => {
    expect(guardOpenPaths('C:\\lib\\a.skp', []).ok).toEqual([])
    expect(guardOpenPaths('C:\\lib\\a.skp', undefined as unknown as string[]).ok).toEqual([])
    // 含脏项的 roots：脏项被忽略，合法项照常生效
    const r = guardOpenPaths('C:\\lib\\a.skp', [null, '', LIB] as unknown as string[])
    expect(r.ok).toEqual(['C:\\lib\\a.skp'])
  })

  it('大小写 / 末尾分隔符不影响放行', () => {
    expect(guardOpenPaths('c:\\LIB\\a.skp', ROOTS).ok).toEqual(['c:\\LIB\\a.skp'])
    expect(guardOpenPaths('C:\\lib\\a.skp\\', ROOTS).ok).toEqual(['C:\\lib\\a.skp\\'])
  })
})

// ── guardTrashPaths ─────────────────────────────────────────────────────

describe('guardTrashPaths', () => {
  /** [paths, 期望 ok, 说明] */
  const CASES: Array<[string[], string[], string]> = [
    // 正常：资产目录（四层，`库根/大类/一级/二级/资产名` 的资产名层）
    [
      ['C:\\lib\\模型\\椅子\\酒店\\椅子_01'],
      ['C:\\lib\\模型\\椅子\\酒店\\椅子_01'],
      '库内资产目录 → 放行'
    ],
    [
      ['C:\\lib\\材质\\石材\\大理石\\黑白根'],
      ['C:\\lib\\材质\\石材\\大理石\\黑白根'],
      '库内材质目录 → 放行'
    ],
    [
      ['C:\\lib\\模型\\椅子\\酒店\\椅子_01', 'C:\\lib\\模型\\椅子\\酒店\\椅子_02'],
      ['C:\\lib\\模型\\椅子\\酒店\\椅子_01', 'C:\\lib\\模型\\椅子\\酒店\\椅子_02'],
      '多个库内目录 → 全部放行'
    ],
    [
      ['c:\\LIB\\模型\\椅子\\酒店\\椅子_01'],
      ['c:\\LIB\\模型\\椅子\\酒店\\椅子_01'],
      '大小写不同 → 放行'
    ],
    [
      ['C:\\lib\\模型\\椅子\\酒店\\椅子_01\\'],
      ['C:\\lib\\模型\\椅子\\酒店\\椅子_01\\'],
      '末尾分隔符 → 放行'
    ],
    // 结构节点：库根本身
    [['C:\\lib'], [], '库根本身 → 拒'],
    [['C:\\lib\\'], [], '库根本身（尾分隔符）→ 拒'],
    [['C:\\LIB'], [], '库根本身（大小写）→ 拒'],
    // 结构节点：直接子目录 = 大类目录
    [['C:\\lib\\模型'], [], '大类目录 模型 → 拒'],
    [['C:\\lib\\材质'], [], '大类目录 材质 → 拒'],
    [['C:\\lib\\CAD'], [], '大类目录 CAD → 拒'],
    [['C:\\lib\\HDR'], [], '大类目录 HDR → 拒'],
    [['C:\\lib\\贴图'], [], '大类目录 贴图 → 拒'],
    // 保留目录
    [['C:\\lib\\.trash'], [], '.trash 自身 → 拒'],
    [['C:\\lib\\.trash\\椅子_01-2026'], [], '.trash 内 → 拒'],
    [['C:\\lib\\.trash\\.meta\\x.json'], [], '.trash/.meta 内 → 拒'],
    [['C:\\lib\\.staging'], [], '.staging 自身 → 拒'],
    [['C:\\lib\\.staging\\<uuid>\\a.skp'], [], '.staging 内 → 拒'],
    // 库外
    [['C:\\lib2\\模型\\椅子'], [], '同前缀兄弟库 → 拒'],
    [['D:\\工作\\图纸'], [], '库外目录 → 拒'],
    [['C:\\Users\\u\\Desktop'], [], '桌面 → 拒'],
    // 穿越
    [['C:\\lib\\..\\evil'], [], '穿越出根 → 拒'],
    [['C:\\lib\\模型\\..\\..\\evil'], [], '多级穿越出根 → 拒'],
    // 相对 / 空
    [['模型\\椅子'], [], '相对路径 → 拒'],
    [[''], [], '空串 → 拒'],
    [['.'], [], '当前目录 → 拒']
  ]

  for (const [paths, expectedOk, label] of CASES) {
    it(label, () => {
      const r = guardTrashPaths(paths, LIB)
      expect(r.ok).toEqual(expectedOk)
      expect(r.ok.length + r.rejected.length).toBe(paths.length)
    })
  }

  it('混合批次：放行的照常放行，危险的进 rejected（原始字符串）', () => {
    const batch = [
      'C:\\lib\\模型\\椅子\\酒店\\椅子_01',
      'C:\\lib\\模型',
      'C:\\lib\\..\\evil',
      'D:\\工作\\图纸'
    ]
    const r = guardTrashPaths(batch, LIB)
    expect(r.ok).toEqual(['C:\\lib\\模型\\椅子\\酒店\\椅子_01'])
    expect(r.rejected).toEqual(['C:\\lib\\模型', 'C:\\lib\\..\\evil', 'D:\\工作\\图纸'])
  })

  it('非数组入参 → { ok: [], rejected: [] } 且不抛（保持旧容错行为）', () => {
    const BAD: unknown[] = [null, undefined, 123, 'C:\\lib\\模型\\椅子', {}]
    for (const bad of BAD) {
      const r = guardTrashPaths(bad, LIB)
      expect(r.ok).toEqual([])
      expect(r.rejected).toEqual([])
    }
  })

  it('数组成员非字符串 → 拒且不抛', () => {
    const r = guardTrashPaths(
      [null, undefined, 42, 'C:\\lib\\模型\\椅子\\酒店\\椅子_01'] as unknown[],
      LIB
    )
    expect(r.ok).toEqual(['C:\\lib\\模型\\椅子\\酒店\\椅子_01'])
    expect(r.rejected).toEqual(['null', 'undefined', '42'])
  })

  it('库根为空 / 非字符串 → 全拒（没有可信的允许根时不删任何东西）', () => {
    const paths = ['C:\\lib\\模型\\椅子\\酒店\\椅子_01']
    for (const badLib of ['', null, undefined, 123]) {
      const r = guardTrashPaths(paths, badLib as string)
      expect(r.ok).toEqual([])
      expect(r.rejected).toEqual(paths)
    }
  })

  it('库根为文件系统根时不误判为"全在根内"', () => {
    const r = guardTrashPaths(['C:\\lib\\模型\\椅子\\酒店\\椅子_01'], '/')
    expect(r.ok).toEqual([])
    expect(r.rejected).toHaveLength(1)
  })
})
