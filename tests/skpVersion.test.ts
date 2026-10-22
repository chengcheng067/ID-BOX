import { describe, expect, it } from 'vitest'
import { parseSkpVersion, suLabel, SKP_HEAD_BYTES } from '../src/shared/skpVersion'

/** 合成 .skp 头部：magic FF FE FF 0E + UTF-16LE 文本 */
function head(text: string): Uint8Array {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe, 0xff, 0x0e]),
    Buffer.from(text, 'utf16le')
  ])
}

describe('suLabel', () => {
  it('major >= 17 → SU 2000+major', () => {
    expect(suLabel(17)).toBe('SU 2017')
    expect(suLabel(24)).toBe('SU 2024')
  })

  it('major <= 16 → SU major（旧版）', () => {
    expect(suLabel(15)).toBe('SU 15')
    expect(suLabel(8)).toBe('SU 8')
  })
})

describe('parseSkpVersion', () => {
  it('解析 SketchUp Model {24.0.594}', () => {
    const info = parseSkpVersion(head('SketchUp Model {24.0.594}'))
    expect(info).not.toBeNull()
    expect(info!.major).toBe(24)
    expect(info!.minor).toBe(0)
    expect(info!.build).toBe(594)
    expect(info!.label).toBe('SU 2024')
    expect(info!.raw).toBe('{24.0.594}')
  })

  it('解析 SketchUp Model {17.1.174}', () => {
    expect(parseSkpVersion(head('SketchUp Model {17.1.174}'))?.label).toBe('SU 2017')
  })

  it('解析旧版 {15.3.331}', () => {
    const info = parseSkpVersion(head('SketchUp Model {15.3.331}'))
    expect(info?.label).toBe('SU 15')
    expect(info?.major).toBe(15)
  })

  it('无花括号时靠 SketchUp 字样兜底', () => {
    expect(parseSkpVersion(head('SketchUp Model 23.1.340'))?.label).toBe('SU 2023')
  })

  it('缺 magic → null', () => {
    expect(parseSkpVersion(Buffer.from('SketchUp Model {24.0.594}', 'utf16le'))).toBeNull()
    expect(parseSkpVersion(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]))).toBeNull()
  })

  it('空 / 随机字节 / 截断头 → null', () => {
    expect(parseSkpVersion(Buffer.alloc(0))).toBeNull()
    expect(parseSkpVersion(Buffer.from([0xff, 0xfe, 0xff, 0x0e]))).toBeNull()
    expect(parseSkpVersion(Buffer.alloc(128, 0xab))).toBeNull()
    expect(parseSkpVersion(head(''))).toBeNull()
  })

  it('有 magic 但没有版本号 → null', () => {
    expect(parseSkpVersion(head('SketchUp Model'))).toBeNull()
  })

  it('null / undefined 输入安全返回 null', () => {
    expect(parseSkpVersion(null)).toBeNull()
    expect(parseSkpVersion(undefined)).toBeNull()
  })

  it('约定读取长度为 128 字节', () => {
    expect(SKP_HEAD_BYTES).toBe(128)
    const buf = Buffer.concat([head('SketchUp Model {24.0.594}'), Buffer.alloc(200, 0x20)])
    expect(parseSkpVersion(buf.subarray(0, SKP_HEAD_BYTES))?.label).toBe('SU 2024')
  })
})
