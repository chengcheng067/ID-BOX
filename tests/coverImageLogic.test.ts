/**
 * 封面图片输入（渲染层纯逻辑）单测（2026-10 装机反馈，任务 3）。
 *
 * 被测对象来自 `src/renderer/logic/coverImage.ts`——不 import React / store，
 * DOM 对象用结构等价的桩（File/DataTransfer 在本模块里只触达少量字段）。
 */
import { describe, expect, it } from 'vitest'
import {
  coverImageInputOf,
  firstImageFileOfClipboard,
  firstImageFileOfDataTransfer,
  isImageFile
} from '../src/renderer/logic/coverImage'

/** 结构等价的 File 桩（本模块只读 .type） */
function fakeFile(type: string): File {
  return { type } as unknown as File
}

describe('isImageFile', () => {
  it('image/* MIME 通过，其余拒绝', () => {
    expect(isImageFile(fakeFile('image/png'))).toBe(true)
    expect(isImageFile(fakeFile('image/jpeg'))).toBe(true)
    expect(isImageFile(fakeFile('text/plain'))).toBe(false)
    expect(isImageFile(fakeFile(''))).toBe(false)
    expect(isImageFile(null)).toBe(false)
  })
})

describe('firstImageFileOfDataTransfer', () => {
  it('取第一个图片文件', () => {
    const dt = { files: [fakeFile('text/plain'), fakeFile('image/png')] } as unknown as DataTransfer
    expect(firstImageFileOfDataTransfer(dt)?.type).toBe('image/png')
  })

  it('没有图片 / 没有 files → null', () => {
    const dt = { files: [fakeFile('text/plain')] } as unknown as DataTransfer
    expect(firstImageFileOfDataTransfer(dt)).toBeNull()
    expect(firstImageFileOfDataTransfer(null)).toBeNull()
    expect(firstImageFileOfDataTransfer({} as DataTransfer)).toBeNull()
  })
})

describe('firstImageFileOfClipboard', () => {
  it('items 里的图片优先（getAsFile）', () => {
    const file = fakeFile('image/png')
    const cd = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => file }
      ],
      files: []
    } as unknown as DataTransfer
    expect(firstImageFileOfClipboard(cd)).toBe(file)
  })

  it('items 没有图片时退回 files 兜底', () => {
    const file = fakeFile('image/jpeg')
    const cd = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [file]
    } as unknown as DataTransfer
    expect(firstImageFileOfClipboard(cd)).toBe(file)
  })

  it('纯文本粘贴 → null', () => {
    const cd = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: []
    } as unknown as DataTransfer
    expect(firstImageFileOfClipboard(cd)).toBeNull()
    expect(firstImageFileOfClipboard(null)).toBeNull()
  })
})

describe('coverImageInputOf', () => {
  it('拿到绝对路径 → source:file（大图不走 base64 IPC）', async () => {
    const input = await coverImageInputOf(fakeFile('image/png'), {
      getPathForFile: () => 'C:\\Users\\u\\Desktop\\shot.png'
    })
    expect(input).toEqual({ source: 'file', path: 'C:\\Users\\u\\Desktop\\shot.png' })
  })

  it('拿不到路径（剪贴板截图常见）→ 退化为 base64', async () => {
    const input = await coverImageInputOf(fakeFile('image/png'), {
      getPathForFile: () => '',
      readAsBase64: async () => 'AAAA'
    })
    expect(input).toEqual({ source: 'clipboard', data: 'AAAA' })
  })

  it('getPathForFile 抛错 → 也走 base64 退化', async () => {
    const input = await coverImageInputOf(fakeFile('image/jpeg'), {
      getPathForFile: () => {
        throw new Error('no path')
      },
      readAsBase64: async () => 'BBBB'
    })
    expect(input).toEqual({ source: 'clipboard', data: 'BBBB' })
  })

  it('base64 也读不到 → null', async () => {
    const input = await coverImageInputOf(fakeFile('image/png'), {
      getPathForFile: () => '',
      readAsBase64: async () => {
        throw new Error('read failed')
      }
    })
    expect(input).toBeNull()
  })

  it('非图片 File → null（不浪费 IPC）', async () => {
    const input = await coverImageInputOf(fakeFile('text/plain'), {
      getPathForFile: () => 'C:\\a.txt'
    })
    expect(input).toBeNull()
  })
})
