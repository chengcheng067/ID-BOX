import { describe, expect, it } from 'vitest'
import {
  requiredBytesFor,
  evaluateSpace,
  humanGB,
  DEFAULT_SAFETY_FACTOR
} from '../src/shared/space'

const GB = 1024 * 1024 * 1024

describe('requiredBytesFor', () => {
  it('required = uncompressed × 1.2 + archive', () => {
    expect(requiredBytesFor({ uncompressedBytes: 1000, archiveBytes: 100 })).toBe(1300)
  })

  it('默认安全系数是 1.2', () => {
    expect(DEFAULT_SAFETY_FACTOR).toBe(1.2)
    expect(requiredBytesFor({ uncompressedBytes: 1000, archiveBytes: 0 })).toBe(1200)
  })

  it('可覆盖安全系数', () => {
    expect(requiredBytesFor({ uncompressedBytes: 1000, archiveBytes: 0, safetyFactor: 2 })).toBe(2000)
  })

  it('非法输入按 0 处理', () => {
    expect(requiredBytesFor({ uncompressedBytes: NaN, archiveBytes: NaN })).toBe(0)
    expect(requiredBytesFor({ uncompressedBytes: -5, archiveBytes: -5 })).toBe(0)
  })
})

describe('evaluateSpace', () => {
  const input = { uncompressedBytes: 10 * GB, archiveBytes: GB }

  it('刚好够 → ok', () => {
    const need = requiredBytesFor(input)
    expect(evaluateSpace(need, input).ok).toBe(true)
  })

  it('差 1 字节 → 不 ok', () => {
    const need = requiredBytesFor(input)
    expect(evaluateSpace(need - 1, input).ok).toBe(false)
  })

  it('不足时给出"可用 X GB / 需要 Y GB"文案', () => {
    const check = evaluateSpace(5 * GB, input)
    expect(check.ok).toBe(false)
    expect(check.message).toContain('磁盘空间不足')
    expect(check.message).toContain('可用 5.0 GB')
    expect(check.message).toContain('需要 13.0 GB')
  })

  it('充足时文案说明可用与需要', () => {
    const check = evaluateSpace(50 * GB, input)
    expect(check.ok).toBe(true)
    expect(check.message).toContain('空间充足')
  })

  it('取不到可用空间（0）时判为不足', () => {
    expect(evaluateSpace(0, input).ok).toBe(false)
  })
})

describe('humanGB', () => {
  it('保留一位小数', () => {
    expect(humanGB(12.44 * GB)).toBe('12.4 GB')
    expect(humanGB(0)).toBe('0.0 GB')
  })

  it('非法值兜底为 0.0 GB', () => {
    expect(humanGB(NaN)).toBe('0.0 GB')
    expect(humanGB(-1)).toBe('0.0 GB')
  })
})
