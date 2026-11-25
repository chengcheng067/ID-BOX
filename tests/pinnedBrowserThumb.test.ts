/**
 * 浏览器缩略图 / 类型徽标 / Quick Look 序列的纯逻辑单测
 * （对应 `src/renderer/logic/pinnedBrowser.ts` 的「缩略图与类型徽章」段；
 *  UI 组件（fileTypeBadge / PinnedThumb / PinnedQuickLook）靠源码纪律 + typecheck 守，
 *  与其它纯渲染组件同口径 —— vitest environment 是 node，没有 jsdom）。
 */
import { describe, expect, it } from 'vitest'
import {
  fileTypeBadgeOf,
  isThumbCapableName,
  quickLookFileNames,
  stepQuickLookFile,
  thumbCacheKey,
  ThumbUrlLru
} from '../src/renderer/logic/pinnedBrowser'

const dir = (name: string) => ({ name, isDir: true })
const file = (name: string) => ({ name, isDir: false })

describe('isThumbCapableName', () => {
  it('图片白名单（jpg/jpeg/png/webp/bmp/gif）与 skp 可请求缩略图，大小写不敏感', () => {
    expect(isThumbCapableName(file('方案效果图-01.jpg'))).toBe(true)
    expect(isThumbCapableName(file('photo.JPEG'))).toBe(true)
    expect(isThumbCapableName(file('logo.png'))).toBe(true)
    expect(isThumbCapableName(file('banner.webp'))).toBe(true)
    expect(isThumbCapableName(file('扫描件.bmp'))).toBe(true)
    expect(isThumbCapableName(file('动图.gif'))).toBe(true)
    expect(isThumbCapableName(file('小别墅.skp'))).toBe(true)
    expect(isThumbCapableName(file('小别墅.SKP'))).toBe(true)
  })
  it('白名单之外（svg / ico / dwg / max / 无扩展名）与目录一律 false', () => {
    expect(isThumbCapableName(file('图标.svg'))).toBe(false)
    expect(isThumbCapableName(file('favicon.ico'))).toBe(false)
    expect(isThumbCapableName(file('图纸.dwg'))).toBe(false)
    expect(isThumbCapableName(file('模型.max'))).toBe(false)
    expect(isThumbCapableName(file('README'))).toBe(false)
    expect(isThumbCapableName(file('.gitignore'))).toBe(false)
    expect(isThumbCapableName(dir('素材包'))).toBe(false)
  })
})

describe('fileTypeBadgeOf', () => {
  it('品牌大字卡：skp→SU、max→max、dwg/dxf→CAD、d5a→D5A（大小写不敏感）', () => {
    expect(fileTypeBadgeOf(file('亭子.skp'))).toEqual({ tone: 'su', label: 'SU' })
    expect(fileTypeBadgeOf(file('亭子.SKP'))).toEqual({ tone: 'su', label: 'SU' })
    expect(fileTypeBadgeOf(file('客厅.max'))).toEqual({ tone: 'max', label: 'max' })
    expect(fileTypeBadgeOf(file('平面图.dwg'))).toEqual({ tone: 'cad', label: 'CAD' })
    expect(fileTypeBadgeOf(file('立面图.dxf'))).toEqual({ tone: 'cad', label: 'CAD' })
    expect(fileTypeBadgeOf(file('整包.d5a'))).toEqual({ tone: 'd5a', label: 'D5A' })
  })
  it('图片类→image 图标兜底；其余→generic；目录→null', () => {
    expect(fileTypeBadgeOf(file('效果图.jpg'))).toEqual({ tone: 'image', label: '' })
    expect(fileTypeBadgeOf(file('截图.PNG'))).toEqual({ tone: 'image', label: '' })
    expect(fileTypeBadgeOf(file('说明.txt'))).toEqual({ tone: 'generic', label: '' })
    expect(fileTypeBadgeOf(file('无扩展名'))).toEqual({ tone: 'generic', label: '' })
    expect(fileTypeBadgeOf(dir('素材包'))).toBeNull()
  })
})

describe('thumbCacheKey', () => {
  it('根目录（空 dirRel）与子目录生成不同 key，互不撞车', () => {
    expect(thumbCacheKey('', 'a.skp')).toBe('\u0000a.skp')
    expect(thumbCacheKey('客厅', 'a.skp')).toBe('客厅\u0000a.skp')
    expect(thumbCacheKey('', 'a.skp')).not.toBe(thumbCacheKey('x', 'a.skp'))
  })
})

describe('ThumbUrlLru', () => {
  it('put/get 往返；未命中返回 null', () => {
    const lru = new ThumbUrlLru(3)
    expect(lru.get('k1')).toBeNull()
    lru.put('k1', 'pinned-thumb://x')
    expect(lru.get('k1')).toBe('pinned-thumb://x')
  })
  it('超上限淘汰最久未用（插入序最旧的先走）', () => {
    const lru = new ThumbUrlLru(2)
    lru.put('k1', 'u1')
    lru.put('k2', 'u2')
    lru.put('k3', 'u3')
    expect(lru.get('k1')).toBeNull() // k1 最旧被淘汰
    expect(lru.get('k2')).toBe('u2')
    expect(lru.get('k3')).toBe('u3')
  })
  it('get 刷新新鲜度：被读过的条目不会先被淘汰；重复 put 同 key 更新值', () => {
    const lru = new ThumbUrlLru(2)
    lru.put('k1', 'u1')
    lru.put('k2', 'u2')
    expect(lru.get('k1')).toBe('u1') // k1 刚被读过 → k2 成为最旧
    lru.put('k3', 'u3')
    expect(lru.get('k1')).toBe('u1')
    expect(lru.get('k2')).toBeNull()
    lru.put('k1', 'u1-updated')
    expect(lru.get('k1')).toBe('u1-updated')
    expect(lru.get('k3')).toBe('u3')
  })
})

describe('quickLookFileNames / stepQuickLookFile', () => {
  const entries = [dir('素材包'), file('a.jpg'), file('b.skp'), file('c.max'), dir('子目录'), file('d.png')]

  it('序列只含文件且保持传入顺序（目录剔除）', () => {
    expect(quickLookFileNames(entries)).toEqual(['a.jpg', 'b.skp', 'c.max', 'd.png'])
  })

  it('←/→ 步进；到边界不绕回（返回 null = 原地不动）', () => {
    const seq = quickLookFileNames(entries)
    expect(stepQuickLookFile(seq, 'a.jpg', 1)).toBe('b.skp')
    expect(stepQuickLookFile(seq, 'b.skp', -1)).toBe('a.jpg')
    expect(stepQuickLookFile(seq, 'a.jpg', -1)).toBeNull() // 首再往前 = 不动
    expect(stepQuickLookFile(seq, 'd.png', 1)).toBeNull() // 尾再往后 = 不动
  })

  it('当前项不在序列（目录 / 已删除）返回 null', () => {
    const seq = quickLookFileNames(entries)
    expect(stepQuickLookFile(seq, '素材包', 1)).toBeNull()
    expect(stepQuickLookFile(seq, 'deleted.jpg', 1)).toBeNull()
    expect(stepQuickLookFile([], 'a.jpg', 1)).toBeNull()
  })
})
