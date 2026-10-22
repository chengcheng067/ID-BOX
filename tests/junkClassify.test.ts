import { describe, expect, it } from 'vitest'
import { isJunkFileName } from '../src/shared/classify'

/**
 * 下载站杂质判定单测（2026-10 装机反馈：知末包结构）。
 *
 * 判定规则（src/shared/classify.ts）：
 * ① 文件名含推广词（微信扫码/知末/推广/说明/必用/下载/扫码/二维码/qrcode）；
 * ② 扩展名 ∈ {.html, .htm, .txt, .url}；
 * ③ 经典垃圾名（desktop.ini / Thumbs.db / .DS_Store）。
 */

describe('isJunkFileName — 用户截图证实的真实垃圾文件', () => {
  it('微信二维码推广图 → junk', () => {
    expect(isJunkFileName('微信扫码 看案例找灵感下素材必用知末.jpg')).toBe(true)
    expect(isJunkFileName('微信二维码.png')).toBe(true)
  })

  it('知末推广页/说明 → junk', () => {
    expect(isJunkFileName('知末SU-掌握行业前沿，探索设计趋势.html')).toBe(true)
    expect(isJunkFileName('知末网说明.txt')).toBe(true)
    expect(isJunkFileName('知末网.html')).toBe(true)
  })
})

describe('isJunkFileName — 推广词命中（规则①）', () => {
  it('命中词库', () => {
    expect(isJunkFileName('推广广告.jpg')).toBe(true)
    expect(isJunkFileName('使用说明.doc')).toBe(true)
    expect(isJunkFileName('下载必看.png')).toBe(true)
    expect(isJunkFileName('扫码领取.zip')).toBe(true)
    expect(isJunkFileName('qrcode.png')).toBe(true)
  })

  it('大小写不敏感（英文词）', () => {
    expect(isJunkFileName('QRCode.PNG')).toBe(true)
    expect(isJunkFileName('PROMO.html')).toBe(true)
  })
})

describe('isJunkFileName — 扩展名命中（规则②）', () => {
  it('文档/网页/快捷方式扩展名 → junk（无论文件名）', () => {
    expect(isJunkFileName('readme.txt')).toBe(true)
    expect(isJunkFileName('index.html')).toBe(true)
    expect(isJunkFileName('page.HTM')).toBe(true)
    expect(isJunkFileName('知末网.url')).toBe(true)
    expect(isJunkFileName('无扩展名的文件')).toBe(false) // 无扩展名不吃扩展名规则
  })
})

describe('isJunkFileName — 经典垃圾名（规则③）', () => {
  it('desktop.ini / Thumbs.db / .DS_Store → junk', () => {
    expect(isJunkFileName('desktop.ini')).toBe(true)
    expect(isJunkFileName('Thumbs.db')).toBe(true)
    expect(isJunkFileName('.DS_Store')).toBe(true)
  })
})

describe('isJunkFileName — 正常资产文件不误判', () => {
  it('模型/贴图/HDRI/材质文件都不是 junk', () => {
    expect(isJunkFileName('znzmo-1186414883-1.skp')).toBe(false)
    expect(isJunkFileName('预览图.jpg')).toBe(false)
    expect(isJunkFileName('贴图/木纹 01.jpg'.split('/').pop()!)).toBe(false)
    expect(isJunkFileName('现代衣柜.max')).toBe(false)
    expect(isJunkFileName('room.exr')).toBe(false)
    expect(isJunkFileName('材质.vismat')).toBe(false)
    expect(isJunkFileName('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风.skp')).toBe(false)
  })

  it('空名不判 junk', () => {
    expect(isJunkFileName('')).toBe(false)
  })
})
