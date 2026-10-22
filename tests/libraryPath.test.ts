/**
 * 库内回灌守卫（v0.5.4 数据事故）—— 渲染层纯逻辑单测。
 *
 * 事故：卡片拖出到建模软件后，在窗口内松手 → window `drop` 的 `dataTransfer.types`
 * 只有 `['Files']` → 被当成"从资源管理器拖进来的文件" → 库里多出 `名字-2…-6` 副本，
 * 且原文件可能被 `disposeArchive` 处置。这层判定负责把库内路径挡在导入链路之外。
 */
import { describe, expect, it } from 'vitest'
import {
  isInsideLibrary,
  normalizeWinPath,
  pathsOutsideLibrary
} from '../src/renderer/logic/libraryPath'

const LIB = 'E:\\ModVault\\Library'

describe('libraryPath · isInsideLibrary（Windows 语义）', () => {
  it('库根本身算"在库内"（连尾部分隔符也一样）', () => {
    expect(isInsideLibrary(LIB, LIB)).toBe(true)
    expect(isInsideLibrary(LIB, `${LIB}\\`)).toBe(true)
    expect(isInsideLibrary(`${LIB}\\`, `${LIB}\\`)).toBe(true)
  })

  it('大小写不敏感（Windows 同一目录）', () => {
    expect(isInsideLibrary(LIB, 'e:\\modvault\\library\\模型\\a.skp')).toBe(true)
    expect(isInsideLibrary('e:\\MODVAULT\\LIBRARY', `${LIB}\\模型`)).toBe(true)
  })

  it('正/反斜杠混用等价', () => {
    expect(isInsideLibrary(LIB, 'E:/ModVault/Library/模型/未分类/a.skp')).toBe(true)
    expect(isInsideLibrary('E:/ModVault/Library/', 'E:\\ModVault\\Library\\a.jpg')).toBe(true)
  })

  it('同前缀不同目录不算库内（Library2 / Library-old 陷阱）', () => {
    expect(isInsideLibrary(LIB, 'E:\\ModVault\\Library2\\模型\\a.skp')).toBe(false)
    expect(isInsideLibrary(LIB, 'E:\\ModVault\\Library-old\\a.skp')).toBe(false)
    expect(isInsideLibrary(LIB, 'E:\\ModVault\\Librar\\a.skp')).toBe(false)
  })

  it('完全不同盘 / 库的父目录不算库内', () => {
    expect(isInsideLibrary(LIB, 'D:\\ModVault\\Library\\a.skp')).toBe(false)
    expect(isInsideLibrary(LIB, 'E:\\ModVault\\a.skp')).toBe(false)
    expect(isInsideLibrary(LIB, 'E:\\a.skp')).toBe(false)
  })

  it('空值一律 false（设置未加载完时交给主进程兜底）', () => {
    expect(isInsideLibrary(null, 'E:\\a.skp')).toBe(false)
    expect(isInsideLibrary(undefined, 'E:\\a.skp')).toBe(false)
    expect(isInsideLibrary('', 'E:\\a.skp')).toBe(false)
    expect(isInsideLibrary(LIB, '')).toBe(false)
    expect(isInsideLibrary(LIB, null)).toBe(false)
  })

  it('normalizeWinPath：统一分隔符 / 去尾部斜杠 / 转小写', () => {
    expect(normalizeWinPath('E:/ModVault/Library//')).toBe('e:\\modvault\\library')
    expect(normalizeWinPath('  E:\\ModVault\\Library  ')).toBe('e:\\modvault\\library')
    expect(normalizeWinPath('E:\\')).toBe('e:')
  })
})

describe('libraryPath · pathsOutsideLibrary（drop 批量过滤）', () => {
  it('只留下库外路径，保持原顺序', () => {
    const out = pathsOutsideLibrary(LIB, [
      'C:\\Users\\me\\Desktop\\新包.zip',
      `${LIB}\\模型\\a.skp`,
      'D:\\贴图\\石材.jpg'
    ])
    expect(out).toEqual(['C:\\Users\\me\\Desktop\\新包.zip', 'D:\\贴图\\石材.jpg'])
  })

  it('全部在库内 → 空数组（调用方据此不调 importPaths）', () => {
    expect(
      pathsOutsideLibrary(LIB, [`${LIB}\\a.skp`, 'e:/modvault/library/模型/b.skp'])
    ).toEqual([])
  })

  it('去重（大小写/斜杠变体视为同一条）但保留首个原始写法', () => {
    const out = pathsOutsideLibrary(LIB, [
      'C:\\Temp\\a.zip',
      'c:/temp/A.ZIP',
      'C:\\Temp\\b.zip'
    ])
    expect(out).toEqual(['C:\\Temp\\a.zip', 'C:\\Temp\\b.zip'])
  })

  it('空输入安全', () => {
    expect(pathsOutsideLibrary(LIB, [])).toEqual([])
    expect(pathsOutsideLibrary(null, ['C:\\a.zip'])).toEqual(['C:\\a.zip'])
  })
})
