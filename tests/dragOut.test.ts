/**
 * 系统级拖出统一入口 `beginSystemDrag` 的单测（2026-10 拖出闪退回归守卫）。
 *
 * 事故根因：`dragstart` 里没有 `preventDefault()` → 渲染进程自己的 HTML5 拖拽照常启动，
 * 主进程 `startDrag` 又在同一线程发起 OLE `DoDragDrop` → 两次原生拖拽重入 → Windows 崩溃。
 * 所以这里不只测函数行为，还做**源码守卫**：任何 `window.modvault.startDrag(` 调用
 * 都必须挂在含 `beginSystemDrag(` 的 `onDragStart` 处理器里；归类抓手必须豁免。
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INTERNAL_DRAG_OUT_WINDOW_MS,
  beginSystemDrag,
  isInternalDragOut,
  markInternalDragOut,
  resetInternalDragOut
} from '../src/renderer/logic/dragOut'

beforeEach(() => {
  resetInternalDragOut()
})

function readRendererFile(rel: string): string {
  return readFileSync(new URL(`../src/renderer/${rel}`, import.meta.url), 'utf8')
}

/**
 * 去掉块注释与整行注释后再做源码守卫。
 * 注释里也会出现 `window.modvault.startDrag()` 这类示例文本，不剥掉会误判成真实调用。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取出所有真实的 `onDragStart` 处理器片段（按源码顺序，到下一个处理器/文件尾为止） */
function dragHandlerBlocks(src: string): string[] {
  // 只匹配属性写法（JSX `onDragStart={` / 对象 `onDragStart:`），不匹配注释里裸提到的方法名
  const starts = [...src.matchAll(/onDragStart\s*[=:]/g)].map((m) => m.index ?? 0)
  return starts.map((start, i) => src.slice(start, starts[i + 1] ?? src.length))
}

describe('dragOut · beginSystemDrag 调用顺序与参数', () => {
  it('preventDefault 先于 startDrag（先掐掉渲染进程自己的拖拽，再发起唯一一次系统拖拽）', () => {
    const calls: string[] = []
    const preventDefault = vi.fn(() => calls.push('preventDefault'))
    const setData = vi.fn(() => calls.push('setData'))
    const startDrag = vi.fn(() => calls.push('startDrag'))
    const ev = { preventDefault, dataTransfer: { setData, effectAllowed: '' } }

    beginSystemDrag(ev, '北欧沙发.skp', 'C:\\Lib\\模型\\北欧沙发.skp', 'thumb-1.jpg', startDrag)

    expect(calls).toEqual(['preventDefault', 'setData', 'startDrag'])
    // 显式用 vitest 的调用序号断言（需求 1 的写法）
    expect(preventDefault.mock.invocationCallOrder[0]).toBeLessThan(
      startDrag.mock.invocationCallOrder[0]!
    )
  })

  it('setData 只调一次且是 text/plain + label；effectAllowed 置 copy', () => {
    const setData = vi.fn()
    const ev = { preventDefault: vi.fn(), dataTransfer: { setData, effectAllowed: '' } }

    beginSystemDrag(ev, '贴图.png', 'C:\\Lib\\石材\\贴图.png', null, vi.fn())

    expect(setData).toHaveBeenCalledTimes(1)
    expect(setData).toHaveBeenCalledWith('text/plain', '贴图.png')
    expect(ev.dataTransfer.effectAllowed).toBe('copy')
  })

  it('startDrag 原样收到 (abs, thumbName)：thumb 存在则传文件名，缺失则为 null', () => {
    const startDrag = vi.fn()
    const ev = { preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: '' } }

    beginSystemDrag(ev, 'a', 'C:\\Lib\\a.skp', 'thumb-a.jpg', startDrag)
    expect(startDrag).toHaveBeenLastCalledWith('C:\\Lib\\a.skp', 'thumb-a.jpg')

    beginSystemDrag(ev, 'b', 'C:\\Lib\\b.skp', null, startDrag)
    expect(startDrag).toHaveBeenLastCalledWith('C:\\Lib\\b.skp', null)
  })
})

describe('dragOut · 内部拖出时间窗（防误弹导入遮罩 / 防回灌）', () => {
  it('标记后窗口内为 true，超过 10 秒为 false', () => {
    markInternalDragOut(1_000_000)
    expect(isInternalDragOut(1_000_000)).toBe(true)
    expect(isInternalDragOut(1_000_000 + INTERNAL_DRAG_OUT_WINDOW_MS - 1)).toBe(true)
    expect(isInternalDragOut(1_000_000 + INTERNAL_DRAG_OUT_WINDOW_MS)).toBe(false)
    expect(isInternalDragOut(1_000_000 + 60_000)).toBe(false)
  })

  it('未标记过 / 已 reset → 恒 false（普通外部拖入必须照常显示遮罩）', () => {
    expect(isInternalDragOut(1_000_000)).toBe(false)
    markInternalDragOut(1_000_000)
    resetInternalDragOut()
    expect(isInternalDragOut(1_000_000)).toBe(false)
  })

  it('时钟回拨（now < 标记时间）仍算窗口内，不会闪出遮罩', () => {
    markInternalDragOut(1_000_000)
    expect(isInternalDragOut(999_000)).toBe(true)
  })

  it('beginSystemDrag 内部会自动打标记（调用方无需关心）', () => {
    const ev = { preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: '' } }
    expect(isInternalDragOut(5_000)).toBe(false)
    beginSystemDrag(ev, 'a', 'C:\\Lib\\a.skp', null, vi.fn())
    expect(isInternalDragOut(Date.now())).toBe(true)
  })
})

describe('dragOut · 源码守卫（防止再次出现"两次原生拖拽"）', () => {
  it('AssetGrid：卡片 / 文件行两处系统拖出都经 beginSystemDrag', () => {
    const src = stripComments(readRendererFile('components/AssetGrid.tsx'))
    const directCalls = [...src.matchAll(/window\.modvault\.startDrag\(/g)]
    // 卡片本体 + 文件夹视图文件行
    expect(directCalls.length).toBe(2)

    const handlers = dragHandlerBlocks(src)
    const systemHandlers = handlers.filter((h) => h.includes('window.modvault.startDrag('))
    expect(systemHandlers.length).toBe(2)
    for (const h of systemHandlers) {
      expect(h).toContain('beginSystemDrag(')
    }
  })

  it('DetailPanel：详情文件行的系统拖出经 beginSystemDrag', () => {
    const src = stripComments(readRendererFile('components/DetailPanel.tsx'))
    const directCalls = [...src.matchAll(/window\.modvault\.startDrag\(/g)]
    expect(directCalls.length).toBe(1)

    const handlers = dragHandlerBlocks(src)
    const systemHandlers = handlers.filter((h) => h.includes('window.modvault.startDrag('))
    expect(systemHandlers.length).toBe(1)
    expect(systemHandlers[0]).toContain('beginSystemDrag(')
  })

  it('归类抓手 gripProps 必须豁免：不调 beginSystemDrag、不 preventDefault（否则左栏收不到 drop）', () => {
    const src = stripComments(readRendererFile('components/AssetGrid.tsx'))
    const start = src.indexOf('const gripProps')
    const end = src.indexOf('const clickProps', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const grip = src.slice(start, end)

    expect(grip).not.toContain('beginSystemDrag')
    expect(grip).not.toContain('preventDefault')
    // 抓手的应用内通道必须还在（否则"抓手不生效"会被误改成走到系统拖出）
    expect(grip).toContain('ASSET_DRAG_MIME')
  })

  it('卡片拖出的 [data-assign-grip] 守卫必须排在 beginSystemDrag 之前', () => {
    const src = stripComments(readRendererFile('components/AssetGrid.tsx'))
    const handlers = dragHandlerBlocks(src)
    // 「卡片本体」处理器 = 同时含抓手守卫与系统拖出调用的那一段
    // （只看 data-assign-grip 会误命中 GripHandle 的类型声明块）
    const cardHandler = handlers.find(
      (h) => h.includes('data-assign-grip') && h.includes('window.modvault.startDrag(')
    )
    expect(cardHandler).toBeDefined()

    const guardAt = cardHandler!.indexOf("closest('[data-assign-grip]')")
    const dragAt = cardHandler!.indexOf('beginSystemDrag(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(dragAt).toBeGreaterThan(-1)
    // 顺序反了：beginSystemDrag 会 preventDefault 掉抓手的 HTML5 拖拽 → 归类失效
    expect(guardAt).toBeLessThan(dragAt)
  })
})
