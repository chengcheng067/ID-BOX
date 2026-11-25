import { describe, expect, it } from 'vitest'
import {
  comparePinnedEntries,
  emptyHistory,
  extOf,
  historyBack,
  historyForward,
  hitNames,
  isAdFileName,
  isArchiveName,
  kindLabelOf,
  nameExists,
  pushHistory,
  sortPinnedEntries,
  type PinnedViewPrefs
} from '../src/renderer/logic/pinnedBrowser'

const dir = (name: string) => ({ name, isDir: true })
const file = (name: string, size?: number, mtimeMs?: number) => ({
  name,
  isDir: false,
  ...(size === undefined ? {} : { size }),
  ...(mtimeMs === undefined ? {} : { mtimeMs })
})

describe('extOf / kindLabelOf', () => {
  it('取小写扩展名；无扩展名返回空串', () => {
    expect(extOf('方案效果图-01.PNG')).toBe('png')
    expect(extOf('材质清单.zip')).toBe('zip')
    expect(extOf('README')).toBe('')
    expect(extOf('.gitignore')).toBe('')
    expect(extOf('a.b.c')).toBe('c')
  })
  it('kindLabelOf：目录是「文件夹」，文件是扩展名大写，无扩展名是「文件」', () => {
    expect(kindLabelOf(dir('2.1-初稿方案'))).toBe('文件夹')
    expect(kindLabelOf(file('平面布置图.png'))).toBe('PNG')
    expect(kindLabelOf(file('LICENSE'))).toBe('文件')
  })
})

describe('isArchiveName / isAdFileName', () => {
  it('压缩包扩展名判断（大小写不敏感）', () => {
    expect(isArchiveName(file('a.zip'))).toBe(true)
    expect(isArchiveName(file('B.7Z'))).toBe(true)
    expect(isArchiveName(file('c.rar'))).toBe(true)
    expect(isArchiveName(file('d.tar.gz'))).toBe(true)
    expect(isArchiveName(file('e.png'))).toBe(false)
    expect(isArchiveName(dir('archive'))).toBe(false)
  })
  it('站方推广文件词表：文件名含「微信扫码」「知末」即算', () => {
    expect(isAdFileName('微信扫码.png')).toBe(true)
    expect(isAdFileName('知末网说明.html')).toBe(true)
    expect(isAdFileName('关于知末的使用须知.txt')).toBe(true)
    expect(isAdFileName('方案效果图-01.png')).toBe(false)
    expect(isAdFileName('readme.txt')).toBe(false)
  })
})

describe('comparePinnedEntries / sortPinnedEntries', () => {
  const entries = [
    file('b.png', 200, 300),
    dir('文件夹B'),
    file('a.png', 100, 500),
    dir('文件夹A'),
    file('c.zip', 300, 100)
  ]

  it('目录恒排文件前面（任何排序键与方向下）', () => {
    const prefsDesc: PinnedViewPrefs = { view: 'list', sortKey: 'name', sortDir: 'desc' }
    const sorted = sortPinnedEntries(entries, prefsDesc)
    expect(sorted.slice(0, 2).map((e) => e.name)).toEqual(['文件夹B', '文件夹A'])
    expect(sorted.slice(2).map((e) => e.name)).toEqual(['c.zip', 'b.png', 'a.png'])
  })

  it('默认名称升序（中文按拼音段）', () => {
    const sorted = sortPinnedEntries(entries, { view: 'list', sortKey: 'name', sortDir: 'asc' })
    expect(sorted.map((e) => e.name)).toEqual([
      '文件夹A',
      '文件夹B',
      'a.png',
      'b.png',
      'c.zip'
    ])
  })

  it('大小排序：升序小在前，降序大在前', () => {
    const asc = sortPinnedEntries(entries, { view: 'list', sortKey: 'size', sortDir: 'asc' })
    const desc = sortPinnedEntries(entries, { view: 'list', sortKey: 'size', sortDir: 'desc' })
    expect(asc.filter((e) => !e.isDir).map((e) => e.name)).toEqual(['a.png', 'b.png', 'c.zip'])
    expect(desc.filter((e) => !e.isDir).map((e) => e.name)).toEqual(['c.zip', 'b.png', 'a.png'])
  })

  it('修改时间排序：升序旧在前，降序新在前', () => {
    const asc = sortPinnedEntries(entries, { view: 'list', sortKey: 'mtime', sortDir: 'asc' })
    const desc = sortPinnedEntries(entries, { view: 'list', sortKey: 'mtime', sortDir: 'desc' })
    expect(asc.filter((e) => !e.isDir).map((e) => e.name)).toEqual(['c.zip', 'b.png', 'a.png'])
    expect(desc.filter((e) => !e.isDir).map((e) => e.name)).toEqual(['a.png', 'b.png', 'c.zip'])
  })

  it('类型排序：按扩展名分组，同组按名称', () => {
    const sorted = sortPinnedEntries(entries, { view: 'list', sortKey: 'kind', sortDir: 'asc' })
    expect(sorted.filter((e) => !e.isDir).map((e) => e.name)).toEqual(['a.png', 'b.png', 'c.zip'])
  })

  it('comparePinnedEntries 不修改原数组（sortPinnedEntries 返回新数组）', () => {
    const copy = [...entries]
    sortPinnedEntries(entries, { view: 'list', sortKey: 'name', sortDir: 'desc' })
    expect(entries).toEqual(copy)
  })

  it('comparePinnedEntries 单对比较：目录恒在文件前', () => {
    expect(comparePinnedEntries(dir('z'), file('a'), 'name', 'asc')).toBeLessThan(0)
    expect(comparePinnedEntries(file('a'), dir('z'), 'name', 'desc')).toBeGreaterThan(0)
    expect(comparePinnedEntries(file('a'), file('b'), 'name', 'asc')).toBeLessThan(0)
    expect(comparePinnedEntries(file('a'), file('b'), 'name', 'desc')).toBeGreaterThan(0)
  })
})

describe('历史栈', () => {
  it('初始栈只有根', () => {
    const h = emptyHistory()
    expect(h.stack).toEqual([[]])
    expect(h.index).toBe(0)
    expect(historyBack(h)).toBeNull()
    expect(historyForward(h)).toBeNull()
  })

  it('下钻 → push；后退/前进移动游标', () => {
    let h = emptyHistory()
    h = pushHistory(h, ['A'])
    h = pushHistory(h, ['A', 'B'])
    expect(h.index).toBe(2)
    const back = historyBack(h)
    expect(back?.index).toBe(1)
    expect(back?.stack[1]).toEqual(['A'])
    const fwd = historyForward(back!)
    expect(fwd?.index).toBe(2)
    expect(fwd?.stack[2]).toEqual(['A', 'B'])
  })

  it('刷新/同层跳转去重：push 相同段数组不产生新记录', () => {
    let h = emptyHistory()
    h = pushHistory(h, ['A'])
    const again = pushHistory(h, ['A'])
    expect(again).toBe(h)
    expect(h.stack.length).toBe(2)
  })

  it('面包屑回跳（新跳转）清掉游标之后的前进记录', () => {
    let h = emptyHistory()
    h = pushHistory(h, ['A'])
    h = pushHistory(h, ['A', 'B'])
    h = pushHistory(h, ['A', 'C'])
    expect(h.stack.length).toBe(4) // [根, A, A/B, A/C]
    const backToA = historyBack(historyBack(h)!)!
    expect(backToA.index).toBe(1)
    const branched = pushHistory(backToA, ['A', 'D'])
    expect(branched.stack.map((s) => s.join('/'))).toEqual(['', 'A', 'A/D'])
    expect(branched.index).toBe(2)
    expect(historyForward(branched)).toBeNull()
  })

  it('栈上限 100：裁掉最旧记录', () => {
    let h = emptyHistory()
    for (let i = 0; i < 120; i += 1) h = pushHistory(h, [`d${i}`])
    expect(h.stack.length).toBe(100)
    expect(h.index).toBe(99)
    expect(h.stack[99]).toEqual(['d119'])
  })
})

describe('框选几何命中（hitNames）', () => {
  it('相交即命中，按渲染顺序返回', () => {
    const rects = new Map([
      ['a', { left: 0, top: 0, right: 50, bottom: 20 }],
      ['b', { left: 0, top: 24, right: 50, bottom: 44 }]
    ])
    const hits = hitNames(rects, ['b', 'a'], { left: 0, top: 10, right: 50, bottom: 30 })
    expect(hits).toEqual(['b', 'a'])
  })
  it('仅边界相切不算命中', () => {
    const rects = new Map([['a', { left: 0, top: 0, right: 50, bottom: 20 }]])
    expect(hitNames(rects, ['a'], { left: 50, top: 0, right: 100, bottom: 20 })).toEqual([])
    expect(hitNames(rects, ['a'], { left: 0, top: 20, right: 50, bottom: 40 })).toEqual([])
  })
  it('未采集矩形（不可见）的条目不命中', () => {
    const rects = new Map([['a', { left: 0, top: 0, right: 50, bottom: 20 }]])
    expect(hitNames(rects, ['a', 'ghost'], { left: 0, top: 0, right: 50, bottom: 20 })).toEqual(['a'])
  })
})

describe('nameExists（重命名/新建冲突预检）', () => {
  it('Windows 文件系统大小写不敏感', () => {
    expect(nameExists(['a.png', 'b.txt'], 'A.PNG')).toBe(true)
    expect(nameExists(['a.png', 'b.txt'], 'c.png')).toBe(false)
  })
  it('排除自身（重命名未改动时不算冲突）', () => {
    expect(nameExists(['a.png', 'b.txt'], 'A.PNG', 'a.png')).toBe(false)
    expect(nameExists(['a.png', 'b.txt'], 'b.txt', 'a.png')).toBe(true)
  })
})
