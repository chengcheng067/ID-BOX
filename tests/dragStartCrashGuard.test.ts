/**
 * drag:start 图标加载失败崩溃的兜底（0.8.3 P0）。
 *
 * 崩溃现场（外部用户 v0.8.2，2026-10-28 07:27:40 UTC）：
 *   Error: Failed to load image from path 'C:\...\Temp\idbox-drag-card.png'
 *   —— startDrag 内部对字符串 icon 路径 createFromPath 读成空图直接 throw
 *   （杀软对刚落盘 PNG 的瞬时独占扫描锁，间歇性竞态，用户 6 秒后重拖即成功）。
 *
 * 本文件钉两层：
 * ① 纯逻辑：`guardDragIconPath` 对「空图 / 读抛错」必须降级内嵌图标且自身不 throw；
 * ② 源码守卫：主处理器确实接了守卫 + try/catch，渲染层 dragstart 仍是
 *   「同步读缓存、命中发完整字节 / 未命中发 null」的钉死顺序（防后人改回去）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { guardDragIconPath, type DragIconGuardDeps } from '../src/main/dragIconGuard'

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

/** NativeImage 桩：只保留守卫用得到的 isEmpty 语义 */
interface FakeImg {
  empty: boolean
}

function makeDeps(
  empty: boolean,
  throwOnLoad = false,
  loadCalls: string[] = []
): DragIconGuardDeps<FakeImg> {
  return {
    loadFromPath: (p: string) => {
      loadCalls.push(p)
      if (throwOnLoad) throw new Error('EBUSY: resource busy or locked')
      return { empty }
    },
    isEmpty: (img: FakeImg) => img.empty,
    makeEmbedded: () => ({ empty: false })
  }
}

describe('dragIconGuard · 主进程 isEmpty 降级纯逻辑', () => {
  it('路径读出非空图 → 原样保留路径（Windows 只认「icon 为路径」那条分支）', () => {
    const calls: string[] = []
    const res = guardDragIconPath('C:/tmp/icon.png', makeDeps(false, false, calls))
    expect(res).toEqual({ icon: 'C:/tmp/icon.png', degraded: false, reason: null })
    expect(calls).toEqual(['C:/tmp/icon.png'])
  })

  it('★路径读成空图（杀软瞬时锁）→ 降级内嵌图标，不 throw', () => {
    const res = guardDragIconPath('C:/tmp/idbox-drag-card.png', makeDeps(true))
    expect(res.degraded).toBe(true)
    expect(res.reason).toBe('decode-empty')
    expect(res.icon).not.toBe('C:/tmp/idbox-drag-card.png')
    expect((res.icon as FakeImg).empty).toBe(false)
  })

  it('★路径读取抛错（文件被独占锁锁死）→ 同样降级内嵌，异常绝不外抛', () => {
    const res = guardDragIconPath('C:/tmp/idbox-drag-card.png', makeDeps(false, true))
    expect(res.degraded).toBe(true)
    expect(res.reason).toBe('decode-error')
    expect((res.icon as FakeImg).empty).toBe(false)
  })

  it('已经是内存图（NativeImage）→ 原样通过，不再触碰路径加载', () => {
    const calls: string[] = []
    const mem = { empty: false }
    const res = guardDragIconPath(mem, makeDeps(true, true, calls))
    expect(res).toEqual({ icon: mem, degraded: false, reason: null })
    expect(calls).toEqual([])
  })
})

describe('源码守卫 · 主处理器接线（防后人改回 throw）', () => {
  const main = readSrc('src/main/index.ts')

  it('★startDrag 之前 icon 路径必须过 guardDragIconPath（初验 + card→thumb 降级后复验）', () => {
    expect(main.match(/guardDragIconPath\(icon\.icon, dragIconDeps\)/g)?.length ?? 0).toBe(2)
    expect(main).toContain("isEmpty: (img: NativeImage) => img.isEmpty()")
  })

  it('★降级必须记 drag:icon-missing（取证）且降级链为 card → thumb → 内嵌', () => {
    expect(main).toContain("logWarn('drag:icon-missing'")
    expect(main).toContain("if (icon.kind === 'card')")
    expect(main).toContain("icon = resolveDragIcon(thumbName)")
    expect(main).toContain("kind: 'embedded', path: null, exists: false")
  })

  it('★startDrag 本身要 try/catch 兜底（drag:start:throw），不允许 uncaughtException', () => {
    expect(main).toMatch(
      /try \{\s*\n\s*\/\/[^\n]*\n\s*event\.sender\.startDrag\(\{ file: abs, icon: icon\.icon \}\)\s*\n\s*\} catch \(err\) \{[\s\S]{0,200}drag:start:throw/
    )
  })

  it('守卫决策逻辑在独立纯文件里（可在 vitest 直测），主文件没有内联 throw', () => {
    expect(readSrc('src/main/dragIconGuard.ts')).toContain('export function guardDragIconPath')
  })
})

describe('源码守卫 · 渲染层「写完才发」契约（防改回去）', () => {
  it('★dragstart 仍是同步读缓存：命中发完整字节 / 未命中发 null，绝不 await 现画', () => {
    const grid = readSrc('src/renderer/components/AssetGrid.tsx')
    // 两处拖出（网格卡 + 文件视图）都是先同步取缓存再 beginSystemDrag
    expect(grid).toContain('const cardPng = cachedDragCard(fileCardKey(row))')
    expect(grid).toContain('const cardPng = cachedDragCard(a.id)')
    expect(grid.match(/startDrag\(path, thumb, cardPng\)/g)?.length ?? 0).toBe(2)
    // 拖出热路径上不允许出现等待（await / then 链）—— 那会把拖拽手势丢掉
    expect(grid).not.toMatch(/await[\s\S]{0,40}beginSystemDrag/)
  })

  it('★只有完整渲染的 PNG 才能进缓存（cacheDragCard 是预热链路最后一步）', () => {
    const dragCard = readSrc('src/renderer/logic/dragCard.ts')
    // 预热写缓存的调用点都挂在 Promise resolve 之后（渲染完成才写字节）
    expect(dragCard).toMatch(/renderWithPreview\(options\)\s*\n\s*\.then\(\(png\) => cacheDragCard/)
    // 空数据 / null 一律拒收
    expect(dragCard).toMatch(/if \(!assetId \|\| !png \|\| png\.byteLength === 0\) return/)
  })
})
