/**
 * 拖拽卡片位图（v0.5.4）—— 可在 node 环境验证的纯逻辑部分。
 *
 * canvas 绘制本身需要真实 DOM（vitest 环境是 node），这里覆盖：
 * ① 两套主题配色（不写死单一颜色）；
 * ② 无 DOM 时 renderDragCard 必须返回 null（调用方据此回退缩略图图标，绝不能让拖拽失效）；
 * ③ 预热缓存的 LRU 上限与「空数据不写入」。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  DRAG_CARD_CACHE_LIMIT,
  DRAG_CARD_HEIGHT,
  DRAG_CARD_WIDTH,
  cacheDragCard,
  cachedDragCard,
  clearDragCardCache,
  dragCardCacheSize,
  dragCardKey,
  dragCardPalette,
  renderDragCard
} from '../src/renderer/logic/dragCard'

beforeEach(() => {
  clearDragCardCache()
})

describe('dragCard · 主题配色', () => {
  it('浅色 = 白卡 + 浅描边 + 深字（与 styles.css 的 token 同值）', () => {
    const p = dragCardPalette('light')
    expect(p.surface).toBe('#ffffff')
    expect(p.border).toBe('#e8edf2')
    expect(p.text).toBe('#1f2937')
  })

  it('深色：卡片底比应用底亮一档（否则深色底上读不出卡片形状）', () => {
    const dark = dragCardPalette('dark')
    const light = dragCardPalette('light')
    // 应用底是 #161618 / 卡片底 #1c1c1e —— 拖拽卡必须更亮，且带内圈高光
    expect(dark.surface).toBe('#2b2b2f')
    expect(dark.ring).toMatch(/rgba\(255,255,255/)
    expect(dark.text).toBe('#f2f2f4')
    expect(dark.surface).not.toBe(light.surface)
    expect(dark.text).not.toBe(light.text)
  })

  it('卡片是正方形（竖版会被看成"一截长图"）', () => {
    expect(DRAG_CARD_WIDTH).toBe(DRAG_CARD_HEIGHT)
  })
})

describe('dragCard · 无 DOM 环境', () => {
  it('renderDragCard 返回 null（调用方回退缩略图图标，不影响拖拽可用性）', async () => {
    expect(typeof document).toBe('undefined')
    const bytes = await renderDragCard({ thumbUrl: 'vault://thumb/a.jpg', name: '北欧沙发' })
    expect(bytes).toBeNull()
  })
})

describe('dragCard · 预热缓存（LRU）', () => {
  it('写入后可命中；空数据不写入', () => {
    expect(cachedDragCard('a')).toBeNull()
    cacheDragCard('a', new Uint8Array([1, 2, 3]))
    expect(cachedDragCard('a')).not.toBeNull()

    cacheDragCard('b', new Uint8Array(0))
    cacheDragCard('c', null)
    expect(cachedDragCard('b')).toBeNull()
    expect(cachedDragCard('c')).toBeNull()
    expect(dragCardCacheSize()).toBe(1)
  })

  it(`超过 ${DRAG_CARD_CACHE_LIMIT} 条时淘汰最久未使用的一条`, () => {
    const id = (i: number) => `asset-${i}`
    for (let i = 0; i < DRAG_CARD_CACHE_LIMIT; i++) {
      cacheDragCard(id(i), new Uint8Array([i + 1]))
    }
    expect(dragCardCacheSize()).toBe(DRAG_CARD_CACHE_LIMIT)

    // 读一次 0 号 → 变成"最近使用"，淘汰的应该是 1 号
    expect(cachedDragCard(id(0))).not.toBeNull()
    cacheDragCard('asset-new', new Uint8Array([9]))

    expect(dragCardCacheSize()).toBe(DRAG_CARD_CACHE_LIMIT)
    expect(cachedDragCard('asset-new')).not.toBeNull()
    expect(cachedDragCard(id(0))).not.toBeNull()
    expect(cachedDragCard(id(1))).toBeNull()
  })

  it('同一 id 重复写入不增加条数（覆盖）', () => {
    cacheDragCard('a', new Uint8Array([1]))
    cacheDragCard('a', new Uint8Array([2, 3]))
    expect(dragCardCacheSize()).toBe(1)
    expect(cachedDragCard('a')!.byteLength).toBe(2)
  })
})

/**
 * 2026-10-21 用户两次反馈拖动观感：
 * ① 文件视图只把缩略图路径交给 `startDrag`（埋点 `cardBytes: 0`），系统按裸图画 → 被裁切；
 * ② 换成卡片位图后用户仍说「像虚影」。
 *
 * 结论（**已实测，不要再走回头路**）：OLE 拖拽期间渲染进程收到 `dragover` 的次数是 **0**
 * （真实鼠标输入下测的：`window.__probeOver === 0`），渲染层根本不知道光标在哪 →
 * 「应用内浮层跟手卡片」这条路走不通，只能把 168×210 卡片位图交给系统画。
 * 这里钉死三处调用点都必须传 cardPng，防止有人再退回裸缩略图。
 */
describe('dragCard · 三处拖出入口都传卡片位图', () => {
  const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

  it('缓存键带 rel：同一资产的不同文件各自一张卡', () => {
    expect(dragCardKey('asset-1')).toBe('asset-1')
    expect(dragCardKey('asset-1', 'a/preview.png')).toBe('asset-1::a/preview.png')
    expect(dragCardKey('asset-1', 'a/preview.png')).not.toBe(dragCardKey('asset-1', 'a/model.skp'))
  })

  it('AssetGrid：网格卡 + 文件视图两处都传 cardPng，文件视图有 hover 预热', () => {
    const src = readSrc('src/renderer/components/AssetGrid.tsx')
    expect(src).toContain('prewarmDragCardBitmap(fileCardKey(row)')
    expect(src).toContain('const cardPng = cachedDragCard(fileCardKey(row))')
    expect(src).toContain('const cardPng = cachedDragCard(a.id)')
    expect(src.match(/startDrag\(path, thumb, cardPng\)/g)?.length ?? 0).toBe(2)
  })

  it('DetailPanel：文件行拖出也传 cardPng', () => {
    const src = readSrc('src/renderer/components/DetailPanel.tsx')
    expect(src).toContain('prewarmDragCard(cardKey')
    expect(src).toContain('const cardPng = cachedDragCard(cardKey)')
    expect(src).toContain('startDrag(path, thumb, cardPng)')
  })

  it('不要再引入「透明图标 + 应用内浮层」那套（dragover 收不到，浮层无法跟手）', () => {
    expect(readSrc('src/renderer/App.tsx')).not.toContain('DragCardOverlay')
    expect(readSrc('src/renderer/logic/dragCard.ts')).not.toContain('transparentDragIcon')
  })
})
