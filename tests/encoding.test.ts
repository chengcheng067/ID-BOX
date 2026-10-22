import { describe, expect, it } from 'vitest'
import {
  hasReplacementChar,
  isMojibakeSuspect,
  scanNames,
  isScanMojibake,
  MOJIBAKE_RATIO_THRESHOLD
} from '../src/shared/encoding'

describe('hasReplacementChar', () => {
  it('含 U+FFFD 时为真', () => {
    expect(hasReplacementChar('预览图\ufffd.jpg')).toBe(true)
  })

  it('正常中文名为假', () => {
    expect(hasReplacementChar('现代衣柜/贴图/木纹 01.jpg')).toBe(false)
  })
})

describe('isMojibakeSuspect', () => {
  it('U+FFFD 直接命中', () => {
    expect(isMojibakeSuspect('预览图\ufffd.jpg')).toBe(true)
  })

  it('UTF-8 字节被当单字节编码解出的产物命中', () => {
    expect(isMojibakeSuspect('æ²™å\x8f‘.jpg')).toBe(true)
    expect(isMojibakeSuspect('Ã©tÃ©.jpg')).toBe(true)
  })

  it('防误伤：单个重音字符不算乱码', () => {
    expect(isMojibakeSuspect('Café Munir.skp')).toBe(false)
  })

  it('防误伤：两个分散的重音字符仍不算乱码', () => {
    expect(isMojibakeSuspect('Café Crème.skp')).toBe(false)
  })

  it('正常中文名与空串不命中', () => {
    expect(isMojibakeSuspect('北欧风布艺沙发')).toBe(false)
    expect(isMojibakeSuspect('')).toBe(false)
  })
})

describe('scanNames', () => {
  it('统计可疑数量与比例，并给出样本', () => {
    const scan = scanNames(['a\ufffd.jpg', 'b.jpg', 'c.png', 'd.skp'])
    expect(scan.total).toBe(4)
    expect(scan.suspicious).toBe(1)
    expect(scan.ratio).toBeCloseTo(0.25, 5)
    expect(scan.hasReplacement).toBe(true)
    expect(scan.samples).toEqual(['a\ufffd.jpg'])
  })

  it('空数组不炸', () => {
    const scan = scanNames([])
    expect(scan.total).toBe(0)
    expect(scan.ratio).toBe(0)
    expect(scan.hasReplacement).toBe(false)
  })

  it('样本最多 5 条', () => {
    const scan = scanNames(Array.from({ length: 9 }, (_, i) => `x\ufffd${i}.jpg`))
    expect(scan.samples.length).toBe(5)
  })
})

describe('isScanMojibake', () => {
  it('有 U+FFFD 即判为整包乱码（不看比例）', () => {
    // 6 个名字里 1 个乱码 → ratio ≈ 0.167 **严格小于** 阈值 0.2，
    // 这样才真正证明了"触发判据是 hasReplacement 而不是比例"
    const scan = scanNames(['a\ufffd.jpg', 'b.jpg', 'c.png', 'd.skp', 'e.max', 'f.png'])
    expect(scan.ratio).toBeLessThan(MOJIBAKE_RATIO_THRESHOLD)
    expect(isScanMojibake(scan)).toBe(true)
  })

  it('无 U+FFFD 时按 20% 阈值判定', () => {
    const below = scanNames(['ok1.jpg', 'ok2.jpg', 'ok3.jpg', 'ok4.jpg', 'æ²™å\x8f‘.jpg'])
    expect(below.ratio).toBeCloseTo(0.2, 5)
    expect(isScanMojibake(below)).toBe(true)

    const above = scanNames(Array.from({ length: 10 }, (_, i) => `ok${i}.jpg`))
    expect(isScanMojibake(above)).toBe(false)
  })

  it('可传入自定义阈值', () => {
    const scan = scanNames(['ok1.jpg', 'ok2.jpg', 'æ²™å\x8f‘.jpg'])
    expect(isScanMojibake(scan, { ratioThreshold: 0.5 })).toBe(false)
  })
})
