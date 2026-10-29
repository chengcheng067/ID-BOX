/**
 * CAD 站方一级别名表单测（`docs/35 §3.2` · R-08 / `src/shared/classifyCadStationAlias.ts`）。
 *
 * 这张表的纪律是"每条必须有出处、只收能唯一确定当前一级的旧名"，所以测试守三件事：
 * 1. **表自身的形状**：`to ∈ CAD_LEVEL1_LIST`、`from ∉ CAD_LEVEL1_LIST`、`source` 非空、
 *    `from` 不重复（重复会让索引后者覆盖前者，静默丢条目）；
 * 2. **查表是精确全等**：`室内空间 → 工装空间`、`节点图块 → null`、
 *    **本地一级 `工装空间` → null**（自指会骗调用方"命中了别名"）；
 * 3. **绝不抛错**：空串 / 纯空白 / `null` / `undefined` 全部返回 `null` ——
 *    它会被面包屑解析直接调用，而站方数据是脏的（`showName` 可能是空串）。
 */
import { describe, expect, it } from 'vitest'

import {
  CAD_STATION_LEVEL1_ALIAS,
  cadStationAliasL1,
  isCadLevel1
} from '../src/shared/classifyCadStationAlias'
import { CAD_LEVEL1_LIST } from '../src/shared/taxonomy'

describe('CAD_STATION_LEVEL1_ALIAS：表自身的不变式', () => {
  it('表非空（空表 = 这条能力被静默删掉）', () => {
    expect(CAD_STATION_LEVEL1_ALIAS.length).toBeGreaterThan(0)
  })

  it('每条 to 必须是当前 CAD 一级（CAD_LEVEL1_LIST 成员）', () => {
    for (const entry of CAD_STATION_LEVEL1_ALIAS) {
      expect(CAD_LEVEL1_LIST, `${entry.from} → ${entry.to} 的 to 不在 CAD 一级词表里`).toContain(
        entry.to
      )
    }
  })

  it('每条 from 不得是当前 CAD 一级（否则这条别名是自指的，说明抄错了）', () => {
    for (const entry of CAD_STATION_LEVEL1_ALIAS) {
      expect(CAD_LEVEL1_LIST, `${entry.from} 本身就是当前一级，不该进别名表`).not.toContain(
        entry.from
      )
    }
  })

  it('每条 source 非空（禁止凭印象补条目）', () => {
    for (const entry of CAD_STATION_LEVEL1_ALIAS) {
      expect(entry.source.trim().length, `${entry.from} 的 source 是空的`).toBeGreaterThan(0)
    }
  })

  it('from 不得重复（重复会让查表索引静默丢条目）', () => {
    const seen = CAD_STATION_LEVEL1_ALIAS.map((e) => e.from)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('至少覆盖 室内空间 → 工装空间（docs/34 §6.3 的 8/36 样本里最主要的一条）', () => {
    expect(CAD_STATION_LEVEL1_ALIAS).toContainEqual(
      expect.objectContaining({ from: '室内空间', to: '工装空间' })
    )
  })
})

describe('cadStationAliasL1：精确全等查表（绝不模糊匹配）', () => {
  it('室内空间 → 工装空间（不是 SU 频道的「工装」）', () => {
    expect(cadStationAliasL1('室内空间')).toBe('工装空间')
  })

  it('节点图块 → null（本地 CAD 词表里没有可靠落点，按纪律不入表）', () => {
    expect(cadStationAliasL1('节点图块')).toBeNull()
  })

  it('工装空间 → null（本地一级不需要别名；返回自己会骗调用方）', () => {
    expect(cadStationAliasL1('工装空间')).toBeNull()
  })

  it('任何当前 CAD 一级都返回 null（表里只有旧名）', () => {
    for (const l1 of CAD_LEVEL1_LIST) expect(cadStationAliasL1(l1)).toBeNull()
  })

  it('不做包含 / 前缀匹配：「室内空间设计」不得命中「室内空间」', () => {
    expect(cadStationAliasL1('室内空间设计')).toBeNull()
    expect(cadStationAliasL1('室内')).toBeNull()
    expect(cadStationAliasL1('空间')).toBeNull()
  })

  it('允许两端空白（站方数据脏过，trim 是唯一容忍的清洗）', () => {
    expect(cadStationAliasL1('  室内空间 ')).toBe('工装空间')
    expect(cadStationAliasL1('\t室内空间\n')).toBe('工装空间')
  })

  it('空串 / 纯空白 / null / undefined 一律 null，不抛错', () => {
    expect(cadStationAliasL1('')).toBeNull()
    expect(cadStationAliasL1('   ')).toBeNull()
    expect(cadStationAliasL1(null)).toBeNull()
    expect(cadStationAliasL1(undefined)).toBeNull()
    // 非字符串入参（IPC / JSON 里可能出现）也不许抛
    expect(cadStationAliasL1(123 as unknown as string)).toBeNull()
    expect(cadStationAliasL1({} as unknown as string)).toBeNull()
  })
})

describe('isCadLevel1：判"要不要去查别名"的辅助查询', () => {
  it('当前一级 → true（含 trim 容忍）', () => {
    expect(isCadLevel1('工装空间')).toBe(true)
    expect(isCadLevel1('  节点详图 ')).toBe(true)
  })

  it('旧一级 / 空 / null → false', () => {
    expect(isCadLevel1('室内空间')).toBe(false)
    expect(isCadLevel1('')).toBe(false)
    expect(isCadLevel1('  ')).toBe(false)
    expect(isCadLevel1(null)).toBe(false)
    expect(isCadLevel1(undefined)).toBe(false)
  })
})
