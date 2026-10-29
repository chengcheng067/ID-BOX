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

/**
 * 2026-10-29 真机补：**7-Zip 的 PUA 乱码**（DEF-01 兜底链从未触发的根因）
 *
 * 真包 `生态主题餐厅工装平面图ID_1152305168.zip`（中央目录 madeBy os=3 / 无 UTF-8 flag）
 * 被裸 7z 解出来的名字长这样（实测码点）：
 *   `餐厅平面设计方案.dwg` → U+EFB2 U+EFCD U+EFCC U+EFFC U+01BD U+EFC3 U+EFE6 U+EFC9 …
 * 即 **私用区 U+E000–U+F8FF** 为主，零星夹着拉丁扩展/希腊/西里尔/希伯来/阿拉伯字符。
 * 老可疑类一个都不覆盖 → ratio=0 → 整条兜底链不触发。
 */
describe('isMojibakeSuspect — PUA（7-Zip / Unix 制作的 GBK zip）', () => {
  it('真包实测的 PUA 乱码名命中', () => {
    expect(isMojibakeSuspect('\uEFB2\uEFCD\uEFCC\uEFFC\u01BD\uEFC3\uEFE6\uEFC9.dwg')).toBe(true)
  })

  it('PUA 与拉丁扩展混排（真包以「知末」开头的那两个）命中', () => {
    expect(isMojibakeSuspect('\u05AA\u0129\u0043\u0041\u0044\u037C\u05BD-\uEFBE\uEFAB\u0461.html')).toBe(true)
    expect(isMojibakeSuspect('\u03A2\uEFD0\uEFC5\u0268\uEFC2\uEFEB \uEFBF.jpg')).toBe(true)
  })

  it('整包扫描：真包 4 个名字里 4 个可疑 → 判整包乱码', () => {
    // 这 4 条是从真包解压结果里**逐码点抄下来的**（不是编的近似串）
    const scan = scanNames([
      '\uEFB2\uEFCD\uEFCC\uEFFC\u01BD\uEFC3\uEFE6\uEFC9\uEFF8\uEFBC\u01B7\uEFBD\uEFB0\uEFB8.dwg',
      '\u05AA\u0129CAD\u037C\u05BD-\uEFBE\uEFAB\u0461\uEFD0\uEFD0\u04B5\u02A9\uEFB9\uEFA4\u037C\uEFA3\uEFAC\u05F7\uEFD7\uEFD9\uEFD7\uEFEE\uEFD0\uEFC2\u037C\u05BD.html',
      '\u05AA\u0129\uEFCD\uEFF8\u02F5\uEFC3\uEFF7.txt',
      '\u03A2\uEFD0\uEFC5\u0268\uEFC2\uEFEB \uEFBF\uEFB4\uEFB0\uEFB8\uEFC0\uEFFD\uEFD5\uEFD2\uEFC1\uEFE9\uEFB8\uEFD0\uEFCF\uEFC2\uEFCB\u0632\u0131\uEFD8\uEFD3\uEFC3\u05AA\u0129.jpg'
    ])
    expect(scan.suspicious).toBe(4)
    expect(scan.ratio).toBe(1)
    expect(isScanMojibake(scan)).toBe(true)
  })
})

/** 反向守卫：把可疑类开太大会让**每个正常包都被重解两遍**，这三条必须仍是 false */
describe('isMojibakeSuspect — 全角标点/全角字母不得误判', () => {
  it('全角括号 + 全角冒号（中文名高频）为假', () => {
    expect(isMojibakeSuspect('（修订版）平面图.dwg')).toBe(false)
    expect(isMojibakeSuspect('【施工图】（修订版）：平面图.dwg')).toBe(false)
  })

  it('全角字母（Ｕ+FF21 在 FF01–FF5E 内）为假', () => {
    expect(isMojibakeSuspect('Ａ号立面.png')).toBe(false)
    expect(isMojibakeSuspect('ＡＢＣ立面图.dwg')).toBe(false)
  })

  it('单个重音外文名（R8 反例）仍为假', () => {
    expect(isMojibakeSuspect('Café Munir.skp')).toBe(false)
  })
})
