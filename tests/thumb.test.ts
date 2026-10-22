import { describe, expect, it } from 'vitest'
import {
  thumbSalt,
  thumbFileName,
  thumbOutputExt,
  parseThumbFileName,
  resizeToMaxPx,
  isThumbOf,
  matchThumbNames,
  findOrphanThumbs,
  DEFAULT_THUMB_MAX_PX,
  THUMB_JPEG_QUALITY,
  THUMB_SALT_LEN
} from '../src/shared/thumb'

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const ID2 = 'ffffffff-0000-4000-8000-000000000000'

describe('thumbSalt', () => {
  it('同输入恒定、异输入不同', () => {
    expect(thumbSalt('/lib/模型/沙发/预览图.jpg')).toBe(thumbSalt('/lib/模型/沙发/预览图.jpg'))
    expect(thumbSalt('/lib/a.jpg')).not.toBe(thumbSalt('/lib/b.jpg'))
  })

  it('默认 8 位十六进制', () => {
    const s = thumbSalt('/lib/a.jpg')
    expect(s).toHaveLength(THUMB_SALT_LEN)
    expect(s).toMatch(/^[0-9a-f]{8}$/)
  })

  it('可指定长度', () => {
    expect(thumbSalt('/lib/a.jpg', 4)).toHaveLength(4)
  })

  it('换封面即换 salt（天然破浏览器缓存）', () => {
    const a = thumbSalt('/lib/模型/沙发/预览图.jpg')
    const b = thumbSalt('/lib/模型/沙发/贴图/木纹.jpg')
    expect(a).not.toBe(b)
  })

  it('空串不炸', () => {
    expect(thumbSalt('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('thumbOutputExt', () => {
  it('png / webp 输出 PNG（保透明底，转 JPEG 会糊成黑底）', () => {
    expect(thumbOutputExt('png')).toBe('png')
    expect(thumbOutputExt('.PNG')).toBe('png')
    expect(thumbOutputExt('webp')).toBe('png')
  })

  it('其余输出 JPEG', () => {
    expect(thumbOutputExt('jpg')).toBe('jpg')
    expect(thumbOutputExt('jpeg')).toBe('jpg')
    expect(thumbOutputExt('tga')).toBe('jpg')
    expect(thumbOutputExt('hdr')).toBe('jpg')
  })
})

describe('thumbFileName / parseThumbFileName', () => {
  it('拼出 <id>-<salt>.<ext>', () => {
    expect(thumbFileName(ID, '1a2b3c4d', 'jpg')).toBe(`${ID}-1a2b3c4d.jpg`)
  })

  it('能解析回来（id 本身含 - ，salt 取最后一段）', () => {
    const name = thumbFileName(ID, '1a2b3c4d', 'jpg')
    expect(parseThumbFileName(name)).toEqual({ id: ID, salt: '1a2b3c4d', ext: 'jpg' })
  })

  it('UUID 末段也是十六进制时仍能正确切分', () => {
    const name = `${ID}-abcdef12.png`
    expect(parseThumbFileName(name)).toEqual({ id: ID, salt: 'abcdef12', ext: 'png' })
  })

  it('大小写不敏感并归一化', () => {
    expect(parseThumbFileName(`${ID}-ABCDEF12.PNG`)).toEqual({ id: ID, salt: 'abcdef12', ext: 'png' })
  })

  it('非缩略图文件返回 null', () => {
    expect(parseThumbFileName('preview.jpg')).toBeNull()
    expect(parseThumbFileName('notes.txt')).toBeNull()
    expect(parseThumbFileName(`${ID}-zzzz.jpg`)).toBeNull() // salt 非十六进制
    expect(parseThumbFileName('')).toBeNull()
  })
})

describe('resizeToMaxPx', () => {
  it('长边超过上限时等比缩小', () => {
    expect(resizeToMaxPx(4000, 3000, 480)).toEqual({ width: 480, height: 360 })
    expect(resizeToMaxPx(3000, 4000, 480)).toEqual({ width: 360, height: 480 })
  })

  it('默认上限 480', () => {
    expect(DEFAULT_THUMB_MAX_PX).toBe(480)
    expect(resizeToMaxPx(2000, 1000)).toEqual({ width: 480, height: 240 })
  })

  it('不放大：原图比上限小就原样返回', () => {
    expect(resizeToMaxPx(200, 150, 480)).toEqual({ width: 200, height: 150 })
    expect(resizeToMaxPx(480, 480, 480)).toEqual({ width: 480, height: 480 })
  })

  it('结果必须 round 且 ≥1（宽度 0 会让 Electron 崩或产出空图）', () => {
    // 极端长条图：1×5000 → 高 480，宽按比例只有 0.096 → 必须兜到 1
    expect(resizeToMaxPx(1, 5000, 480)).toEqual({ width: 1, height: 480 })
    expect(resizeToMaxPx(5000, 1, 480)).toEqual({ width: 480, height: 1 })
  })

  it('非法输入按 1 处理，不产出 0/NaN', () => {
    for (const r of [resizeToMaxPx(0, 0), resizeToMaxPx(-5, 100), resizeToMaxPx(NaN, NaN)]) {
      expect(r.width).toBeGreaterThanOrEqual(1)
      expect(r.height).toBeGreaterThanOrEqual(1)
      expect(Number.isInteger(r.width)).toBe(true)
      expect(Number.isInteger(r.height)).toBe(true)
    }
  })

  it('非法 maxPx 回落默认 480', () => {
    expect(resizeToMaxPx(4000, 2000, 0)).toEqual({ width: 480, height: 240 })
  })
})

describe('isThumbOf / matchThumbNames', () => {
  const names = [`${ID}-aaaaaaaa.jpg`, `${ID}-bbbbbbbb.png`, `${ID2}-cccccccc.jpg`, 'junk.txt']

  it('按 id 通配匹配（salt 会变，不能按固定名找）', () => {
    expect(matchThumbNames(names, ID)).toEqual([`${ID}-aaaaaaaa.jpg`, `${ID}-bbbbbbbb.png`])
    expect(matchThumbNames(names, ID2)).toEqual([`${ID2}-cccccccc.jpg`])
  })

  it('isThumbOf 精确判定', () => {
    expect(isThumbOf(`${ID}-aaaaaaaa.jpg`, ID)).toBe(true)
    expect(isThumbOf(`${ID2}-cccccccc.jpg`, ID)).toBe(false)
    expect(isThumbOf('junk.txt', ID)).toBe(false)
  })

  it('换封面后旧 salt 的残留也能一起删掉', () => {
    expect(matchThumbNames(names, ID).length).toBe(2)
  })
})

describe('findOrphanThumbs', () => {
  it('不在 liveIds 里的才是孤儿', () => {
    const names = [`${ID}-aaaaaaaa.jpg`, `${ID2}-cccccccc.jpg`, 'junk.txt']
    expect(findOrphanThumbs(names, [ID])).toEqual([`${ID2}-cccccccc.jpg`])
  })

  it('非缩略图文件不算孤儿（不误删）', () => {
    expect(findOrphanThumbs(['junk.txt', 'settings.json'], [])).toEqual([])
  })

  it('liveIds 为空时全部缩略图都是孤儿', () => {
    expect(findOrphanThumbs([`${ID}-aaaaaaaa.jpg`], []).length).toBe(1)
  })
})

describe('常量', () => {
  it('JPEG 质量为 82', () => {
    expect(THUMB_JPEG_QUALITY).toBe(82)
  })
})
