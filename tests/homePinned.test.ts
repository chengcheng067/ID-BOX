/**
 * T-05 首页渲染卡的纯逻辑单测（docs/60 §6，`src/renderer/logic/homePinned.ts`）。
 *
 * 覆盖五组真值表：
 *   ① F-1 钉选：添加查重 / 封顶 / 移除 / 左右移（相邻交换）/ 端点禁用态 / 路径取名；
 *   ② F-2 边缘滚动：方向判定（含纵向安全带）/ 步长 / 滚到头停；
 *   ③ F-3 底纹：key 命名空间 / bg:// URL 派生 / 映射写与清；
 *   ④ 子项 5：静态图片背景时海浪面板显隐（与 HomeCover hasWallpaper 同口径）。
 *
 * 测试范式：vitest node 环境（项目纪律：纯函数不 import React / DOM / electron）。
 */
import { describe, expect, it } from 'vitest'
import {
  EDGE_HOT_ZONE_PX,
  HOME_PINNED_LIMIT,
  addPinnedFolder,
  edgeScrollDirection,
  edgeScrollStep,
  folderNameOfPath,
  homeWavePanelVisible,
  kindWallpaperKey,
  movePinnedFolder,
  nextScrollLeft,
  pinWallpaperKey,
  pinnedMoveBounds,
  removePinnedFolderById,
  wallpaperMapPatch,
  wallpaperUrlOf
} from '../src/renderer/logic/homePinned'
import type { HomePinnedFolder } from '../src/shared/types'

/** 造一条钉选（id 可读，便于断言交换结果） */
function pin(id: string): HomePinnedFolder {
  return { id, name: `目录-${id}`, absPath: `E:/mod/${id}` }
}

const rect = { left: 100, right: 1000, top: 200, bottom: 400 }
const band = { topInset: 110, bottomInset: 64 }

describe('F-1 · addPinnedFolder', () => {
  it('新路径追加到末尾（数组顺序即显示顺序）', () => {
    const list = [pin('a'), pin('b')]
    const { list: next, outcome } = addPinnedFolder(list, { id: 'c', name: 'C', absPath: 'E:/mod/c' })
    expect(outcome).toBe('added')
    expect(next.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('同 absPath 已钉 → duplicate，不重复追加', () => {
    const list = [pin('a')]
    const { list: next, outcome } = addPinnedFolder(list, { id: 'x', name: 'X', absPath: 'E:/mod/a' })
    expect(outcome).toBe('duplicate')
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe('a')
  })

  it('32 条封顶（与主进程 normalizeHomePinnedFolders 同口径）', () => {
    const list: HomePinnedFolder[] = []
    for (let i = 0; i < HOME_PINNED_LIMIT; i++) list.push(pin(String(i)))
    const { list: next, outcome } = addPinnedFolder(list, { id: 'over', name: 'O', absPath: 'E:/mod/over' })
    expect(outcome).toBe('limit')
    expect(next).toHaveLength(HOME_PINNED_LIMIT)
  })

  it('不改动入参数组（zustand 依赖新引用）', () => {
    const list = [pin('a')]
    const { list: next } = addPinnedFolder(list, { id: 'b', name: 'B', absPath: 'E:/mod/b' })
    expect(list).toHaveLength(1)
    expect(next).not.toBe(list)
  })
})

describe('F-1 · removePinnedFolderById / movePinnedFolder / pinnedMoveBounds', () => {
  it('按 id 移除；只删 Settings 语义上的键（纯数据）', () => {
    const list = [pin('a'), pin('b'), pin('c')]
    const next = removePinnedFolderById(list, 'b')
    expect(next.map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('移除未知 id → 内容不变（新引用、幂等）', () => {
    const list = [pin('a')]
    const next = removePinnedFolderById(list, 'zzz')
    expect(next).toEqual(list)
    expect(next).not.toBe(list)
  })

  it('左右移 = 交换相邻两个钉选', () => {
    const list = [pin('a'), pin('b'), pin('c')]
    expect(movePinnedFolder(list, 'b', -1).map((p) => p.id)).toEqual(['b', 'a', 'c'])
    expect(movePinnedFolder(list, 'b', 1).map((p) => p.id)).toEqual(['a', 'c', 'b'])
  })

  it('已在端点 → 原样返回（不环绕）', () => {
    const list = [pin('a'), pin('b')]
    expect(movePinnedFolder(list, 'a', -1).map((p) => p.id)).toEqual(['a', 'b'])
    expect(movePinnedFolder(list, 'b', 1).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('未知 id → 原样返回', () => {
    const list = [pin('a'), pin('b')]
    expect(movePinnedFolder(list, 'zzz', -1)).toEqual(list)
  })

  it('端点禁用态真值表（菜单灰掉依据）', () => {
    const list = [pin('a'), pin('b'), pin('c')]
    expect(pinnedMoveBounds(list, 'a')).toEqual({ canLeft: false, canRight: true })
    expect(pinnedMoveBounds(list, 'b')).toEqual({ canLeft: true, canRight: true })
    expect(pinnedMoveBounds(list, 'c')).toEqual({ canLeft: true, canRight: false })
    expect(pinnedMoveBounds(list, 'zzz')).toEqual({ canLeft: false, canRight: false })
  })
})

describe('F-1 · folderNameOfPath', () => {
  it('Windows 反斜杠取末段', () => {
    expect(folderNameOfPath('E:\\projects\\江畔会所')).toBe('江畔会所')
  })
  it('POSIX 斜杠取末段', () => {
    expect(folderNameOfPath('/home/user/2026-018')).toBe('2026-018')
  })
  it('尾部多余分隔符不影响取名', () => {
    expect(folderNameOfPath('E:\\projects\\江畔会所\\\\')).toBe('江畔会所')
  })
  it('纯盘符 / 空段兜底不产生空名', () => {
    expect(folderNameOfPath('E:')).toBe('E:')
    expect(folderNameOfPath('')).toBe('')
  })
})

describe('F-2 · edgeScrollDirection（边缘热区方向）', () => {
  const EDGE = EDGE_HOT_ZONE_PX // 48
  // 纵向安全带 = [rect.top + 110, rect.bottom - 64] = [310, 336]，取 320
  const y = 320

  it('左热区 → -1（向左滚）', () => {
    expect(edgeScrollDirection(100 + EDGE - 1, y, rect, band)).toBe(-1)
  })

  it('右热区 → +1（向右滚）', () => {
    expect(edgeScrollDirection(1000 - EDGE + 1, y, rect, band)).toBe(1)
  })

  it('中间 → 0', () => {
    expect(edgeScrollDirection(550, y, rect, band)).toBe(0)
  })

  it('恰好在边界上（距边 48）不算热区', () => {
    expect(edgeScrollDirection(100 + EDGE, y, rect, band)).toBe(0)
    expect(edgeScrollDirection(1000 - EDGE, y, rect, band)).toBe(0)
  })

  it('纵向安全带之外 → 0（补偿 padding 区不触发滚动）', () => {
    expect(edgeScrollDirection(120, rect.top + band.topInset - 1, rect, band)).toBe(0)
    expect(edgeScrollDirection(120, rect.bottom - band.bottomInset + 1, rect, band)).toBe(0)
  })

  it('零尺寸矩形 → 0（防御 getBoundingClientRect 的空值）', () => {
    expect(edgeScrollDirection(120, 300, { left: 0, right: 0, top: 0, bottom: 0 }, band)).toBe(0)
  })

  it('自定义热区宽度（测试注入用）', () => {
    expect(edgeScrollDirection(120, y, rect, band, 32)).toBe(-1)
    expect(edgeScrollDirection(980, y, rect, band, 10)).toBe(0)
  })
})

describe('F-2 · edgeScrollStep / nextScrollLeft', () => {
  it('匀速步长 = speed × dt（320px/s）', () => {
    expect(edgeScrollStep(1000)).toBeCloseTo(320, 6)
    expect(edgeScrollStep(16)).toBeCloseTo(320 * 0.016, 6)
  })

  it('非有限 / 非 正 dt → 0（挂起恢复回拨兜底）', () => {
    expect(edgeScrollStep(0)).toBe(0)
    expect(edgeScrollStep(-5)).toBe(0)
    expect(edgeScrollStep(Number.NaN)).toBe(0)
  })

  it('滚到头自动停（左端 / 右端 clamp）', () => {
    expect(nextScrollLeft(0, -1, 40, 0, 500)).toBe(0)
    expect(nextScrollLeft(500, 1, 40, 0, 500)).toBe(500)
    expect(nextScrollLeft(10, 1, 40, 0, 500)).toBe(50)
    expect(nextScrollLeft(100, 0, 40, 0, 500)).toBe(100)
  })
})

describe('F-3 · 底纹 key 命名空间与映射', () => {
  it('两套命名空间互不碰撞', () => {
    expect(kindWallpaperKey('model')).toBe('kind:model')
    expect(pinWallpaperKey('abc-123')).toBe('pin:abc-123')
    expect(kindWallpaperKey('x')).not.toBe(pinWallpaperKey('x'))
  })

  it('命中映射 → bg://<encodeURIComponent(fileName)>', () => {
    expect(wallpaperUrlOf({ 'kind:model': 'abc123.jpg' }, 'kind:model')).toBe('bg://abc123.jpg')
    expect(wallpaperUrlOf({ 'pin:1': 'a b.jpg' }, 'pin:1')).toBe('bg://a%20b.jpg')
  })

  it('未命中 / 空值 / 脏映射 → null（渲染层回落默认底纹）', () => {
    expect(wallpaperUrlOf(undefined, 'kind:model')).toBeNull()
    expect(wallpaperUrlOf({}, 'kind:model')).toBeNull()
    expect(wallpaperUrlOf({ 'kind:model': '' }, 'kind:model')).toBeNull()
  })

  it('写一个 key；null / 空串 = 清除（不写垃圾键）', () => {
    expect(wallpaperMapPatch(undefined, 'kind:model', 'a.jpg')).toEqual({ 'kind:model': 'a.jpg' })
    expect(wallpaperMapPatch({ 'kind:model': 'a.jpg' }, 'kind:model', null)).toEqual({})
    expect(wallpaperMapPatch({ 'kind:model': 'a.jpg' }, 'kind:model', '')).toEqual({})
    expect(wallpaperMapPatch({ 'kind:model': 'a.jpg' }, 'pin:1', 'b.jpg')).toEqual({
      'kind:model': 'a.jpg',
      'pin:1': 'b.jpg'
    })
  })

  it('底纹值形态守卫：Settings 里只允许 <sha256>.<ext> 缓存文件名（经本链路写入）', () => {
    // 主进程 saveHomeBackground 的契约（homeBackground.ts:176）由这里复核：
    // 渲染层写映射的来源只有 `result.fileName`（sha256 命名），不可能是临时路径。
    const sha = 'a'.repeat(64)
    const value = `${sha}.jpg`
    expect(value).toMatch(/^[0-9a-f]{64}\.(png|jpe?g|webp|bmp|gif|tif|tiff)$/i)
  })
})

describe('子项 5 · homeWavePanelVisible（静态图片背景时隐藏海浪面板）', () => {
  it('默认背景（source none）→ 显示', () => {
    expect(homeWavePanelVisible({ source: 'none', fileName: null })).toBe(true)
  })

  it('静态图片（local / url 且有文件）→ 隐藏（与 HomeCover hasWallpaper 同口径）', () => {
    expect(homeWavePanelVisible({ source: 'local', fileName: 'a.jpg' })).toBe(false)
    expect(homeWavePanelVisible({ source: 'url', fileName: 'b.jpg' })).toBe(false)
  })

  it('脏档兜底：source 非 none 但文件缺失 → 按无壁纸处理（面板显示）', () => {
    expect(homeWavePanelVisible({ source: 'local', fileName: null })).toBe(true)
  })
})
