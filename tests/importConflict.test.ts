import { describe, expect, it } from 'vitest'
import {
  BatchLedger,
  buildDedupeIndex,
  entryKeyOf,
  matchConflict
} from '../src/main/importConflict'
import { SIZE_MISMATCH_RATIO as SHARED_RATIO, isSizeMismatch } from '../src/shared/dupRules'
import { SIZE_MISMATCH_RATIO as RENDERER_RATIO } from '../src/renderer/logic/duplicates'
import { dedupeKeyOf } from '../src/shared/naming'
import type { AssetKind, ImportDedupeEntry } from '../src/shared/types'

/**
 * docs/27 T-02：导入重复判定的纯逻辑。
 *
 * 这里每条用例都对应 §0 的一句口径（D01/D02/D03/D05）+ §1.2 的判定流程 +
 * §5.1 的批内台账。判重口径一旦与「重复资产」视图漂移，就会出现
 * 「导入时说没重复、进库后重复视图里冒出两条」的自相矛盾，所以断言写得比较死。
 */

function entry(over: Partial<ImportDedupeEntry> & { name: string }): ImportDedupeEntry {
  const kind: AssetKind = over.kind ?? 'model'
  return {
    id: over.id ?? `id-${over.name}`,
    name: over.name,
    kind,
    dedupeKey: over.dedupeKey === undefined ? dedupeKeyOf(over.name, kind) : over.dedupeKey,
    zhimoId: over.zhimoId,
    folder: over.folder ?? `C:/lib/模型/未分类/未分类/${over.name}`,
    relFolder: over.relFolder ?? `模型/未分类/未分类/${over.name}`,
    size: over.size ?? 1000,
    importedAt: over.importedAt ?? 1_700_000_000_000,
    meta: over.meta ?? {
      favorite: false,
      rating: 0,
      colorTag: null,
      tags: [],
      styles: [],
      note: '',
      category1: '未分类',
      category2: '未分类'
    }
  }
}

describe('T-02 ① zhimoId 优先（强判定）', () => {
  it('新素材 ID 命中 → reason=zhimo-id，即使名字完全对不上', () => {
    const index = buildDedupeIndex([
      entry({ id: 'a', name: '现代壁灯', zhimoId: '1232108421' }),
      entry({ id: 'b', name: '完全不同的名字', kind: 'model' })
    ])
    const hit = matchConflict(index, {
      assetName: '壁灯_下载器改名版',
      kind: 'model',
      size: 1000,
      zhimoId: '1232108421'
    })
    expect(hit).not.toBeNull()
    expect(hit!.reason).toBe('zhimo-id')
    expect(hit!.existing.id).toBe('a')
    expect(hit!.otherCopies).toBe(0)
  })

  it('ID 命中优先于同名：同名的那份有别的 ID 时不会被选中', () => {
    // 库里两条：一条同名（ID=999），一条同名同 ID（ID=123）
    const index = buildDedupeIndex([
      entry({ id: 'same-name', name: '吊灯', zhimoId: '999' }),
      entry({ id: 'same-id', name: '吊灯', zhimoId: '123' })
    ])
    const hit = matchConflict(index, { assetName: '吊灯', kind: 'model', size: 1000, zhimoId: '123' })
    expect(hit!.reason).toBe('zhimo-id')
    expect(hit!.existing.id).toBe('same-id')
  })

  it('同 ID 多份 → 取 importedAt 最早的，其余计入 otherCopies', () => {
    const index = buildDedupeIndex([
      entry({ id: 'late', name: '椅子', zhimoId: '555', importedAt: 300 }),
      entry({ id: 'early', name: '椅子(旧)', zhimoId: '555', importedAt: 100 }),
      entry({ id: 'mid', name: '椅子(中)', zhimoId: '555', importedAt: 200 })
    ])
    const hit = matchConflict(index, { assetName: '椅子', kind: 'model', size: 1000, zhimoId: '555' })
    expect(hit!.existing.id).toBe('early')
    expect(hit!.otherCopies).toBe(2)
  })
})

describe('T-02 ② ID 不同 → 不判重（D02，0.6.3 误删修复）', () => {
  it('名字一字不差、ID 不同 → 不冲突', () => {
    const index = buildDedupeIndex([entry({ name: '卧室双人床', zhimoId: '111' })])
    const hit = matchConflict(index, {
      assetName: '卧室双人床',
      kind: 'model',
      size: 1000,
      zhimoId: '222'
    })
    expect(hit).toBeNull()
  })

  it('新素材有 ID 但库里同名的没有 ID → 不冲突（不敢判）', () => {
    const index = buildDedupeIndex([entry({ name: '壁灯', zhimoId: undefined })])
    const hit = matchConflict(index, { assetName: '壁灯', kind: 'model', size: 1000, zhimoId: '333' })
    expect(hit).toBeNull()
  })
})

describe('T-02 ③ 一方有 ID 一方没有 → 不判重（D03）', () => {
  it('新素材无 ID、库里那份有 ID → 不冲突', () => {
    const index = buildDedupeIndex([entry({ name: '壁灯', zhimoId: '123' })])
    const hit = matchConflict(index, { assetName: '壁灯', kind: 'model', size: 1000, zhimoId: null })
    expect(hit).toBeNull()
  })

  it('同键里既有带 ID 的、也有不带 ID 的 → 只和**不带 ID** 的那份判重', () => {
    const index = buildDedupeIndex([
      entry({ id: 'with-id', name: '壁灯', zhimoId: '123' }),
      entry({ id: 'no-id', name: '壁灯', zhimoId: '' })
    ])
    const hit = matchConflict(index, { assetName: '壁灯', kind: 'model', size: 1000, zhimoId: '' })
    expect(hit!.reason).toBe('same-name')
    expect(hit!.existing.id).toBe('no-id')
  })
})

describe('T-02 ④ dedupeKey 回退（弱判定）', () => {
  it('双方无 ID、归一化同名（空格/大小写/全角括号）→ 判重', () => {
    const index = buildDedupeIndex([entry({ name: 'Wood  Texture（A）', kind: 'texture' })])
    const hit = matchConflict(index, {
      assetName: 'wood_texture(a)',
      kind: 'texture',
      size: 1000
    })
    expect(hit!.reason).toBe('same-name')
  })

  it('快照 dedupeKey 为空（极老数据）→ 用 baseNameOf(name)+kind 现场重算，能命中', () => {
    const index = buildDedupeIndex([entry({ name: '椅子-2', kind: 'model', dedupeKey: '' })])
    const hit = matchConflict(index, { assetName: '椅子', kind: 'model', size: 1000 })
    expect(hit).not.toBeNull()
    expect(hit!.reason).toBe('same-name')
    expect(hit!.existing.name).toBe('椅子-2')
  })

  it('查询侧 dedupeKey 缺省 → 用 assetName 重算（先剥自动序号）', () => {
    const index = buildDedupeIndex([entry({ name: '椅子', kind: 'model' })])
    const hit = matchConflict(index, { assetName: '椅子-3', kind: 'model', size: 1000 })
    expect(hit).not.toBeNull()
  })

  it('同名不同 kind → 不判重（落盘大类目录本来就不同）', () => {
    const index = buildDedupeIndex([entry({ name: '木纹', kind: 'model' })])
    const hit = matchConflict(index, { assetName: '木纹', kind: 'texture', size: 1000 })
    expect(hit).toBeNull()
  })

  it('entryKeyOf 对空 dedupeKey 与 dedupeKeyOf(baseNameOf(name), kind) 等价', () => {
    const e = entry({ name: '灰水泥贴图-2', kind: 'texture', dedupeKey: '   ' })
    expect(entryKeyOf(e)).toBe(dedupeKeyOf('灰水泥贴图', 'texture'))
  })
})

describe('T-02 ⑤ 同键多份取最早 + otherCopies', () => {
  it('两条同名 → existing 是 importedAt 早的那条，otherCopies=1', () => {
    // 真实数据里第二份的 dedupeKey 仍是 `model:椅子`（算 key 用的是 uniqueName 之前的名字）
    const key = dedupeKeyOf('椅子', 'model')
    const index = buildDedupeIndex([
      entry({ id: 'newer', name: '椅子-2', dedupeKey: key, importedAt: 200 }),
      entry({ id: 'older', name: '椅子', dedupeKey: key, importedAt: 100 })
    ])
    const hit = matchConflict(index, { assetName: '椅子', kind: 'model', size: 1000 })
    expect(hit!.existing.id).toBe('older')
    expect(hit!.otherCopies).toBe(1)
  })

  it('同一毫秒导入 → 按 id 字典序兜底（结果稳定，不随机）', () => {
    const key = dedupeKeyOf('椅子', 'model')
    const index = buildDedupeIndex([
      entry({ id: 'b-id', name: '椅子', dedupeKey: key, importedAt: 100 }),
      entry({ id: 'a-id', name: '椅子', dedupeKey: key, importedAt: 100 })
    ])
    const hit = matchConflict(index, { assetName: '椅子', kind: 'model', size: 1000 })
    expect(hit!.existing.id).toBe('a-id')
  })
})

describe('T-02 ⑥ sizeMismatch 30% 边界（D05）', () => {
  const index = buildDedupeIndex([entry({ name: '灰水泥贴图', kind: 'texture', size: 1000 })])

  it('差 29.9% → 不提示', () => {
    const hit = matchConflict(index, { assetName: '灰水泥贴图', kind: 'texture', size: 1299 })
    expect(hit!.sizeMismatch).toBe(false)
  })

  it('正好 30.0% → 不提示（严格大于才算）', () => {
    const hit = matchConflict(index, { assetName: '灰水泥贴图', kind: 'texture', size: 1300 })
    expect(hit!.sizeMismatch).toBe(false)
  })

  it('差 30.1% → 提示「可能不是同一套」', () => {
    const hit = matchConflict(index, { assetName: '灰水泥贴图', kind: 'texture', size: 1301 })
    expect(hit!.sizeMismatch).toBe(true)
  })

  it('新素材更小时按较小的一份算（相对口径，不是绝对差）', () => {
    const big = buildDedupeIndex([entry({ name: '大包', kind: 'texture', size: 1301 })])
    expect(matchConflict(big, { assetName: '大包', kind: 'texture', size: 1000 })!.sizeMismatch).toBe(true)
    expect(isSizeMismatch(0, 0)).toBe(false)
    expect(isSizeMismatch(0, 1)).toBe(true)
  })

  it('阈值与渲染层「重复资产」视图同源（防两处口径悄悄漂移）', () => {
    expect(SHARED_RATIO).toBe(RENDERER_RATIO)
    expect(SHARED_RATIO).toBe(0.3)
  })
})

describe('T-02 ⑦ 索引健壮性', () => {
  it('null / 空数组 → 空索引，判重恒 null（= 旧行为）', () => {
    expect(matchConflict(buildDedupeIndex(null), { assetName: '椅子', kind: 'model', size: 1 })).toBeNull()
    expect(
      matchConflict(buildDedupeIndex([]), { assetName: '椅子', kind: 'model', size: 1 })
    ).toBeNull()
    expect(buildDedupeIndex([]).size).toBe(0)
  })

  it('缺 id 的脏条目被丢弃（不能当覆盖的替换目标）', () => {
    const index = buildDedupeIndex([entry({ id: '', name: '椅子' })])
    expect(index.size).toBe(0)
    expect(matchConflict(index, { assetName: '椅子', kind: 'model', size: 1 })).toBeNull()
  })
})

describe('T-02 ⑧ BatchLedger 批内名字台账（§5.1）', () => {
  const dir = 'C:\\lib\\模型\\家具\\椅子'

  it('同一目录并发 reserve 同名 → 名字互不相同（X / X-2 / X-3）', () => {
    const ledger = new BatchLedger()
    // 模拟并发 3：三次 reserve 之间没有任何 await，等价于三个 worker 同时算名字
    const got = [
      ledger.reserve(dir, '椅子', []),
      ledger.reserve(dir, '椅子', []),
      ledger.reserve(dir, '椅子', [])
    ]
    expect(got).toEqual(['椅子', '椅子-2', '椅子-3'])
    expect(new Set(got).size).toBe(3)
  })

  it('磁盘已有名字参与占位（readdir 结果并进 taken）', () => {
    const ledger = new BatchLedger()
    expect(ledger.reserve(dir, '椅子', ['椅子'])).toBe('椅子-2')
    expect(ledger.reserve(dir, '椅子', ['椅子'])).toBe('椅子-3')
  })

  it('release 归还名字，后续条目可以复用（导入失败不白占）', () => {
    const ledger = new BatchLedger()
    const first = ledger.reserve(dir, '椅子', [])
    expect(first).toBe('椅子')
    ledger.release(dir, first)
    expect(ledger.reserve(dir, '椅子', [])).toBe('椅子')
  })

  it('claim 让单图路径自己 mkdir 出的名字被兄弟任务看见', () => {
    const ledger = new BatchLedger()
    ledger.claim(dir, '木纹')
    expect(ledger.namesOf(dir).has('木纹')).toBe(true)
    expect(ledger.reserve(dir, '木纹', [])).toBe('木纹-2')
  })

  it('目录键大小写 / 分隔符不敏感（Windows 语义）', () => {
    const ledger = new BatchLedger()
    ledger.reserve('C:/Lib/模型/家具/椅子', '椅子', [])
    expect(ledger.reserve('c:\\lib\\模型\\家具\\椅子\\', '椅子', [])).toBe('椅子-2')
  })

  it('不同目录互不干扰', () => {
    const ledger = new BatchLedger()
    expect(ledger.reserve(dir, '椅子', [])).toBe('椅子')
    expect(ledger.reserve('C:\\lib\\模型\\灯具\\吊灯', '椅子', [])).toBe('椅子')
  })
})
