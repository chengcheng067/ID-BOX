import { describe, expect, it } from 'vitest'
import { formatBytes, formatDate, extOf, vaultUrl, thumbVaultUrl } from '../src/shared/format'

describe('formatBytes', () => {
  it('各量级取一位小数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })

  it('非法值兜底', () => {
    expect(formatBytes(-1)).toBe('-')
    expect(formatBytes(NaN)).toBe('-')
  })
})

describe('extOf', () => {
  it('取小写扩展名', () => {
    expect(extOf('a.SKP')).toBe('skp')
    expect(extOf('archive.tar.gz')).toBe('gz')
    expect(extOf('noext')).toBe('')
    expect(extOf('.hidden')).toBe('')
  })
})

describe('vaultUrl', () => {
  it('路径逐段编码（中文与空格都要编码，否则协议解析会断）', () => {
    expect(vaultUrl('模型/某 沙发/a.png')).toBe(
      'vault://asset/%E6%A8%A1%E5%9E%8B/%E6%9F%90%20%E6%B2%99%E5%8F%91/a.png'
    )
  })
})

describe('thumbVaultUrl', () => {
  it('缩略图走 vault://thumb/<缓存文件名>', () => {
    expect(thumbVaultUrl('a1b2-9f3c.jpg')).toBe('vault://thumb/a1b2-9f3c.jpg')
  })
})

describe('formatDate', () => {
  it('格式化为 YYYY-MM-DD HH:mm', () => {
    const ts = new Date(2026, 9, 13, 14, 5).getTime()
    expect(formatDate(ts)).toBe('2026-10-13 14:05')
  })
})
