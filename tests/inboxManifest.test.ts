/**
 * SketchUp 插件收件箱的**产物契约**单测（`src/shared/inbox.ts`）。
 *
 * 全部是纯函数表驱动：本仓 vitest 是 `environment: 'node'`，没有 jsdom，
 * 落盘路径由 `tests/inboxUpdate.test.ts` 用真实临时目录覆盖。
 *
 * 这里要钉死的是一组"真值表"——每加一条都希望下一个人一眼看出
 * **哪种 manifest 会被收下、哪种会被判废、判废后用户看到什么中文原因**。
 * 判废文案会原样写进 `failed\<jobId>\error.txt` 和界面 notice，所以断言里带关键字。
 */
import { describe, expect, it } from 'vitest'
import {
  INBOX_API_VERSION,
  describeInboxWriteError,
  isIgnoredInboxPath,
  isInboxJobId,
  isInboxManifestFileName,
  isInboxManifestJson,
  normalizeRelFolder,
  parseInboxManifest,
  planSkpUpdateTarget,
  resolveInboxTargetDir
} from '../src/shared/inbox'

/** 契约基准样本（逐字来自 `docs/probe/su-export-to-idbox.md` §接口契约） */
const VALID_CREATE = {
  apiVersion: 1,
  op: 'create',
  name: '休闲椅',
  skp: '休闲椅.skp',
  cover: '休闲椅.cover.png',
  targetRelFolder: null,
  pluginVersion: '1.2.0',
  createdAt: '2026-11-09T18:40:00+08:00'
}

const VALID_UPDATE = {
  ...VALID_CREATE,
  op: 'update',
  targetRelFolder: '模型/家具/椅子/休闲椅'
}

describe('isInboxJobId', () => {
  const CASES: Array<[unknown, boolean, string]> = [
    ['20261109-184000-ab12', true, '契约形态'],
    ['20261109-184000-AB12', true, '随机段大小写都收（插件可能用 hex）'],
    ['20261109-184000-9x2z', true, '字母数字混合'],
    ['20261109-184000-ab1', false, '随机段不足 4 位'],
    ['20261109-184000-ab123', false, '随机段超过 4 位'],
    ['2026-11-09-184000-ab12', false, '日期带横线'],
    ['20261109184000-ab12', false, '缺分隔横线'],
    ['20261109-184000-ab1-', false, '尾部多余字符'],
    ['', false, '空串'],
    [null, false, 'null'],
    [20261109184000, false, '数字不是 jobId'],
    ['../../../etc', false, '目录穿越形态']
  ]
  for (const [input, expected, why] of CASES) {
    it(`${String(input)} → ${expected}（${why}）`, () => {
      expect(isInboxJobId(input)).toBe(expected)
    })
  }
})

describe('isInboxManifestFileName', () => {
  it('只认 manifest.json 本身', () => {
    expect(isInboxManifestFileName('manifest.json')).toBe(true)
    expect(isInboxManifestFileName('manifest.json.tmp')).toBe(false)
    expect(isInboxManifestFileName('Manifest.json')).toBe(false)
    expect(isInboxManifestFileName('休闲椅.skp')).toBe(false)
  })
})

describe('isIgnoredInboxPath', () => {
  it('.tmp 一律忽略（插件原子写的中间产物）', () => {
    expect(isIgnoredInboxPath('C:\\idbox_export\\incoming\\a\\manifest.json.tmp')).toBe(true)
    expect(isIgnoredInboxPath('C:\\idbox_export\\incoming\\a\\休闲椅.skp.tmp')).toBe(true)
  })
  it('隐藏段一律忽略', () => {
    expect(isIgnoredInboxPath('C:\\idbox_export\\incoming\\.temp\\manifest.json')).toBe(true)
  })
  it('正常 manifest 不忽略', () => {
    expect(isIgnoredInboxPath('C:\\idbox_export\\incoming\\20261109-184000-ab12\\manifest.json')).toBe(false)
  })
  it('空入参当忽略（chokidar 的 ignored 回调偶尔给空串）', () => {
    expect(isIgnoredInboxPath('')).toBe(true)
  })
})

describe('normalizeRelFolder', () => {
  const OK: Array<[string, string[], string]> = [
    ['模型/家具/椅子/休闲椅', ['模型', '家具', '椅子', '休闲椅'], '标准四段'],
    ['模型\\家具\\椅子\\休闲椅', ['模型', '家具', '椅子', '休闲椅'], '反斜杠同样收（插件可能用 \\）'],
    ['模型//家具/', ['模型', '家具'], '重复分隔符 + 尾部分隔符'],
    ['CAD/未分类/未分类/图纸 01', ['CAD', '未分类', '未分类', '图纸 01'], '含空格'],
    ['  模型/家具  ', ['模型', '家具'], '首尾空白被裁']
  ]
  for (const [input, expected, why] of OK) {
    it(`收：${input}（${why}）`, () => {
      const r = normalizeRelFolder(input)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.segments).toEqual(expected)
    })
  }

  const BAD: Array<[unknown, string, string]> = [
    ['', '空', '空串'],
    ['   ', '空', '全空白'],
    [null, '不是字符串', 'null'],
    [123, '不是字符串', '数字'],
    ['C:\\lib\\模型', '盘符', '带盘符 = 绝对路径'],
    ['C:模型', '盘符', '盘符相对同样拒'],
    ['/模型/家具', '分隔符开头', 'POSIX 绝对路径'],
    ['\\模型\\家具', '分隔符开头', 'Windows 根相对'],
    ['模型/../../Windows', '非法路径段', '目录穿越'],
    ['模型/./家具', '非法路径段', '当前目录段'],
    ['模型/.trash/椅子', '保留目录', '.trash 是库内保留目录'],
    ['模型/.staging', '保留目录', '.staging 是导入中间态'],
    ['模型/家具|椅子', '非法字符', 'Windows 非法字符'],
    ['模型/家具?', '非法字符', 'Windows 通配符']
  ]
  for (const [input, keyword, why] of BAD) {
    it(`拒：${String(input)}（${why}）`, () => {
      const r = normalizeRelFolder(input)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain(keyword)
    })
  }
})

describe('parseInboxManifest — 收下的形态', () => {
  it('基准 create 样本逐字段还原', () => {
    const r = parseInboxManifest(VALID_CREATE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest).toEqual({
      apiVersion: INBOX_API_VERSION,
      op: 'create',
      name: '休闲椅',
      skp: '休闲椅.skp',
      cover: '休闲椅.cover.png',
      targetRelFolder: null,
      pluginVersion: '1.2.0',
      createdAt: '2026-11-09T18:40:00+08:00'
    })
  })

  it('基准 update 样本：targetRelFolder 被规范成 posix', () => {
    const r = parseInboxManifest({ ...VALID_UPDATE, targetRelFolder: '模型\\家具\\椅子\\休闲椅' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.targetRelFolder).toBe('模型/家具/椅子/休闲椅')
  })

  it('cover 缺省 → null（插件没截到图，回落 skp 内嵌预览）', () => {
    const { cover: _omit, ...rest } = VALID_CREATE
    const r = parseInboxManifest(rest)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.cover).toBeNull()
  })

  it('cover 显式 null → null', () => {
    const r = parseInboxManifest({ ...VALID_CREATE, cover: null })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.cover).toBeNull()
  })

  it('.jpg 封面也收（isCoverAssetImage 的 jpe?g 分支）', () => {
    const r = parseInboxManifest({ ...VALID_CREATE, cover: '休闲椅.cover.jpg' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.cover).toBe('休闲椅.cover.jpg')
  })

  it('name 首尾空白被裁', () => {
    const r = parseInboxManifest({ ...VALID_CREATE, name: '  休闲椅  ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.name).toBe('休闲椅')
  })
})

describe('parseInboxManifest — 判废真值表', () => {
  /** [说明, 被改坏的 manifest, 期望原因关键字] */
  const BAD: Array<[string, unknown, string]> = [
    ['整体不是对象', 'nope', '不是一个 JSON 对象'],
    ['整体是数组', [], '不是一个 JSON 对象'],
    ['整体是 null', null, '不是一个 JSON 对象'],

    ['apiVersion 缺失', { ...VALID_CREATE, apiVersion: undefined }, 'apiVersion'],
    ['apiVersion 不是整数', { ...VALID_CREATE, apiVersion: 1.5 }, '不是整数'],
    ['apiVersion 是字符串', { ...VALID_CREATE, apiVersion: '1' }, '不是整数'],
    ['apiVersion 不认识的版本', { ...VALID_CREATE, apiVersion: 2 }, '不认识的 manifest.apiVersion=2'],

    ['op 缺失', { ...VALID_CREATE, op: undefined }, 'op 只能是'],
    ['op 拼错', { ...VALID_CREATE, op: 'copy' }, 'op 只能是'],
    ['op 大小写', { ...VALID_CREATE, op: 'Create' }, 'op 只能是'],

    ['name 缺失', { ...VALID_CREATE, name: undefined }, 'name 缺失'],
    ['name 空', { ...VALID_CREATE, name: '   ' }, 'name 为空'],
    ['name 是数字', { ...VALID_CREATE, name: 123 }, 'name 缺失或不是字符串'],
    ['name 过长', { ...VALID_CREATE, name: 'x'.repeat(121) }, 'name 过长'],

    ['skp 缺失', { ...VALID_CREATE, skp: undefined }, 'skp 缺失'],
    ['skp 带路径', { ...VALID_CREATE, skp: 'sub/休闲椅.skp' }, '不能包含路径分隔符'],
    ['skp 带反斜杠', { ...VALID_CREATE, skp: '..\\休闲椅.skp' }, '不能包含路径分隔符'],
    ['skp 扩展名不对', { ...VALID_CREATE, skp: '休闲椅.skp.txt' }, '扩展名不合法'],
    ['skp 不是 skp', { ...VALID_CREATE, skp: '休闲椅.max' }, '扩展名不合法'],
    ['skp 只有扩展名', { ...VALID_CREATE, skp: '.skp' }, '只有扩展名'],

    ['cover 带路径', { ...VALID_CREATE, cover: 'sub/x.cover.png' }, '不能包含路径分隔符'],
    ['cover 扩展名不对', { ...VALID_CREATE, cover: '休闲椅.bmp' }, 'cover 扩展名不合法'],
    ['cover 缺 .cover. 中缀', { ...VALID_CREATE, cover: '休闲椅.png' }, '.cover.png'],

    ['create 却给了 targetRelFolder', { ...VALID_CREATE, targetRelFolder: '模型/家具' }, '必须为 null'],
    ['create 给了空串', { ...VALID_CREATE, targetRelFolder: '' }, '必须为 null'],
    ['update 缺 targetRelFolder', { ...VALID_UPDATE, targetRelFolder: null }, 'targetRelFolder 必填'],
    ['update 的 targetRelFolder 穿越', { ...VALID_UPDATE, targetRelFolder: '../../etc' }, '禁止目录穿越'],
    ['update 的 targetRelFolder 是绝对路径', { ...VALID_UPDATE, targetRelFolder: 'D:\\lib\\x' }, '不能带盘符'],
    ['update 的 targetRelFolder 落 .trash', { ...VALID_UPDATE, targetRelFolder: '.trash/x' }, '保留目录'],

    ['pluginVersion 缺失', { ...VALID_CREATE, pluginVersion: undefined }, 'pluginVersion 缺失'],
    ['pluginVersion 空', { ...VALID_CREATE, pluginVersion: '  ' }, 'pluginVersion 为空'],

    ['createdAt 缺失', { ...VALID_CREATE, createdAt: undefined }, 'createdAt 缺失'],
    ['createdAt 不是时间', { ...VALID_CREATE, createdAt: '昨天下午' }, 'createdAt 不是可解析的时间']
  ]
  for (const [why, input, keyword] of BAD) {
    it(`判废：${why}`, () => {
      const r = parseInboxManifest(input)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain(keyword)
    })
  }
})

describe('isInboxManifestJson — 导入时要不要把这份 json 剔掉', () => {
  it('收件箱形态（apiVersion:1 + op:create）→ 是我们的协议文件', () => {
    expect(isInboxManifestJson(JSON.stringify(VALID_CREATE))).toBe(true)
  })

  it('op:update 同样认（两种 op 都是我们写的）', () => {
    expect(isInboxManifestJson(JSON.stringify(VALID_UPDATE))).toBe(true)
  })

  it('被 strict 解析器判废的也认（比如 name 超长）——它照样是我们的文件', () => {
    const broken = JSON.stringify({ apiVersion: 1, op: 'create', name: 'x'.repeat(300) })
    expect(parseInboxManifest(JSON.parse(broken)).ok).toBe(false)
    expect(isInboxManifestJson(broken)).toBe(true)
  })

  it('用户自带的 manifest.json（没有 apiVersion/op）→ **保留**', () => {
    expect(isInboxManifestJson(JSON.stringify({ name: 'PBR 材质包', files: ['a.jpg'] }))).toBe(false)
  })

  it('apiVersion 不是 1 → 保留（可能是别的软件的同名协议）', () => {
    expect(isInboxManifestJson(JSON.stringify({ apiVersion: 2, op: 'create' }))).toBe(false)
    expect(isInboxManifestJson(JSON.stringify({ apiVersion: '1', op: 'create' }))).toBe(false)
  })

  it('op 不是 create/update → 保留', () => {
    expect(isInboxManifestJson(JSON.stringify({ apiVersion: 1, op: 'delete' }))).toBe(false)
    expect(isInboxManifestJson(JSON.stringify({ apiVersion: 1 }))).toBe(false)
  })

  it('不是 JSON / 不是对象 / 空 → 保留（不删）', () => {
    expect(isInboxManifestJson('not json')).toBe(false)
    expect(isInboxManifestJson('[1,2,3]')).toBe(false)
    expect(isInboxManifestJson('null')).toBe(false)
    expect(isInboxManifestJson('')).toBe(false)
    expect(isInboxManifestJson(undefined)).toBe(false)
  })

  it('超大文本直接拒（不解析，避免拿一个 50MB 的假 manifest 卡住导入）', () => {
    expect(isInboxManifestJson('x'.repeat(64 * 1024 + 1))).toBe(false)
  })
})

describe('resolveInboxTargetDir', () => {
  it('库根 + 四段 → 绝对路径（Windows 分隔符）', () => {
    const r = resolveInboxTargetDir('E:\\ModVault\\Library', '模型/家具/椅子/休闲椅', '\\')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.targetDirAbs).toBe('E:\\ModVault\\Library\\模型\\家具\\椅子\\休闲椅')
      expect(r.relSegments).toEqual(['模型', '家具', '椅子', '休闲椅'])
    }
  })

  it('库根带尾部分隔符不会拼出双分隔符', () => {
    const r = resolveInboxTargetDir('E:\\ModVault\\Library\\', '模型/椅子', '\\')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.targetDirAbs).toBe('E:\\ModVault\\Library\\模型\\椅子')
  })

  it('盘符根也能拼（E:\\ + 帧）', () => {
    const r = resolveInboxTargetDir('E:\\', '模型', '\\')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.targetDirAbs).toBe('E:\\模型')
  })

  it('POSIX 分隔符按入参走', () => {
    const r = resolveInboxTargetDir('/home/u/lib', '模型/椅子', '/')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.targetDirAbs).toBe('/home/u/lib/模型/椅子')
  })

  it('库目录为空 → 判废并提示去设置里选库', () => {
    const r = resolveInboxTargetDir('', '模型', '\\')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('库目录尚未设置')
  })

  it('库目录是相对路径 → 判废（相对路径语义不可控）', () => {
    const r = resolveInboxTargetDir('Library', '模型', '\\')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不是绝对路径')
  })
})

describe('planSkpUpdateTarget — 目标文件名的四档取舍', () => {
  const LIB = 'E:\\ModVault\\Library'
  const REL = '模型/家具/椅子/休闲椅'

  it('① 同名存在 → 覆盖它（exact）', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: REL,
      skpFileName: '休闲椅.skp',
      existingNames: ['休闲椅.skp', '休闲椅.cover.png', 'renderParams.json'],
      sep: '\\'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.targetName).toBe('休闲椅.skp')
      expect(r.targetAbs).toBe('E:\\ModVault\\Library\\模型\\家具\\椅子\\休闲椅\\休闲椅.skp')
      expect(r.selection).toBe('exact')
    }
  })

  it('同名但大小写不同 → 用磁盘原名（不把 Chair.SKP 改成 chair.skp）', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: REL,
      skpFileName: 'chair.skp',
      existingNames: ['Chair.SKP'],
      sep: '\\'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.targetName).toBe('Chair.SKP')
      expect(r.selection).toBe('exact')
    }
  })

  it('② 交付名不在但只有唯一 .skp → 覆盖它（sole-skp，防主文件漂移）', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: REL,
      skpFileName: '休闲椅-减面版.skp',
      existingNames: ['休闲椅.skp', '休闲椅.cover.png'],
      sep: '\\'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.targetName).toBe('休闲椅.skp')
      expect(r.selection).toBe('sole-skp')
    }
  })

  it('③ 一个 .skp 都没有 → 判废（relFolder 指错地方）', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: REL,
      skpFileName: '休闲椅.skp',
      existingNames: ['休闲椅.cover.png', 'readme.txt'],
      sep: '\\'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('没有 .skp 文件')
  })

  it('④ 有多个 .skp 且没有一个同名 → 判废（绝不猜）', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: REL,
      skpFileName: '休闲椅-新.skp',
      existingNames: ['休闲椅-a.skp', '休闲椅-b.skp'],
      sep: '\\'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('无法确定要覆盖哪一个')
  })

  it('未过 normalizeRelFolder 的落点 → 判废', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: '../外面',
      skpFileName: '休闲椅.skp',
      existingNames: ['休闲椅.skp'],
      sep: '\\'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('目录穿越')
  })

  it('交付名不是 .skp → 判废', () => {
    const r = planSkpUpdateTarget({
      libraryDir: LIB,
      targetRelFolder: REL,
      skpFileName: '休闲椅.max',
      existingNames: ['休闲椅.max'],
      sep: '\\'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('扩展名不合法')
  })
})

describe('describeInboxWriteError', () => {
  it('占用类错误要指导用户先去 SketchUp 里关掉文件', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const text = describeInboxWriteError(code, '休闲椅.skp')
      expect(text).toContain('占用')
      expect(text).toContain('SketchUp')
      expect(text).toContain('休闲椅.skp')
    }
  })
  it('ENOSPC → 磁盘空间不足', () => {
    expect(describeInboxWriteError('ENOSPC', 'a.skp')).toContain('磁盘空间不足')
  })
  it('ENOENT → 文件已不在，提示重扫', () => {
    expect(describeInboxWriteError('ENOENT', 'a.skp')).toContain('重新扫描库')
  })
  it('未知码也给出可读文案（带码）', () => {
    const text = describeInboxWriteError('EWEIRD', 'a.skp')
    expect(text).toContain('EWEIRD')
    expect(text).toContain('旧文件已保留')
  })
  it('没有码也不崩', () => {
    expect(describeInboxWriteError(undefined, 'a.skp')).toContain('旧文件已保留')
  })
})
