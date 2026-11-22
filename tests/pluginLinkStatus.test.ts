/**
 * SketchUp 插件联通判定单测（2026-11-22 用户需求「同步插件 · 联通绿点」）。
 *
 * 判据全在 `src/main/pluginLink.ts` 的 `parsePluginLinkStatus`（纯函数、零 IO、
 * 零 electron），这里直接喂 manifest.json 的**原文**字符串。
 *
 * 覆盖的真实数据形状：
 * - 正常 manifest（`shared/pluginSnapshot.ts` 的 `PluginManifest`，字段表 §3.1）；
 * - 半写 / 截断的 manifest（`pluginExport.ts` tmp+rename 之间的窗口）；
 * - enabled 类字段显式 false（导出开关关着 ⇒ 插件只会显示「未开导出」，不亮绿点）；
 * - 旧快照缺 `pluginIndexEnabled` / `generatedAt` 的兼容分支。
 */
import { describe, expect, it } from 'vitest'
import { parsePluginLinkStatus } from '../src/main/pluginLink'

/** 照 `PluginManifest` 字段表拼一份最小合法 manifest（§3.1） */
function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apiVersion: '1',
    appVersion: '1.1.0',
    generatedAt: '2026-11-22T08:00:00.000Z',
    libraryRoot: 'E:/vault',
    pluginIndexEnabled: true,
    state: 'ok',
    lastError: null,
    indexSha256: 'a'.repeat(64),
    indexBytes: 1024,
    indexCount: 3,
    thumbsRoot: 'E:/vault/.thumbs',
    freshnessHintSeconds: 10,
    ...overrides
  })
}

describe('parsePluginLinkStatus · 联通', () => {
  it('合法 manifest ⇒ connected:true，generatedAt 原样透传', () => {
    expect(parsePluginLinkStatus(manifest())).toEqual({
      connected: true,
      generatedAt: '2026-11-22T08:00:00.000Z'
    })
  })

  it('旧快照缺 pluginIndexEnabled 字段 ⇒ 仍联通（缺失不扣分）', () => {
    const raw = JSON.stringify({ generatedAt: '2026-11-21T00:00:00.000Z' })
    expect(parsePluginLinkStatus(raw)).toEqual({
      connected: true,
      generatedAt: '2026-11-21T00:00:00.000Z'
    })
  })

  it('generatedAt 缺失 / 非字符串 ⇒ connected:true 但 generatedAt:null', () => {
    expect(parsePluginLinkStatus('{}')).toEqual({ connected: true, generatedAt: null })
    expect(parsePluginLinkStatus(JSON.stringify({ generatedAt: 42 }))).toEqual({
      connected: true,
      generatedAt: null
    })
    expect(parsePluginLinkStatus(JSON.stringify({ generatedAt: '' }))).toEqual({
      connected: true,
      generatedAt: null
    })
  })
})

describe('parsePluginLinkStatus · enabled 类字段（判据 2）', () => {
  it('pluginIndexEnabled 显式 false ⇒ 不联通（导出关着，亮绿点是骗人）', () => {
    expect(parsePluginLinkStatus(manifest({ pluginIndexEnabled: false }))).toEqual({
      connected: false,
      generatedAt: null
    })
  })

  it('pluginIndexEnabled 非布尔（脏数据）⇒ 不扣分，仍联通', () => {
    expect(parsePluginLinkStatus(manifest({ pluginIndexEnabled: 'yes' })).connected).toBe(true)
  })
})

describe('parsePluginLinkStatus · 一切异常收敛为不联通（判据 1）', () => {
  it('半写 / 截断的 JSON ⇒ 不联通', () => {
    expect(parsePluginLinkStatus('{"apiVersion":"1","generated')).toEqual({
      connected: false,
      generatedAt: null
    })
  })

  it('null / 空串 / 非字符串输入 ⇒ 不联通，且永不抛异常', () => {
    for (const bad of [null, undefined, '', '   ']) {
      expect(parsePluginLinkStatus(bad as string | null)).toEqual({
        connected: false,
        generatedAt: null
      })
    }
  })

  it('顶层不是对象（null / 数组 / 标量）⇒ 不联通', () => {
    expect(parsePluginLinkStatus('null').connected).toBe(false)
    expect(parsePluginLinkStatus('[1,2,3]').connected).toBe(false)
    expect(parsePluginLinkStatus('"ok"').connected).toBe(false)
    expect(parsePluginLinkStatus('42').connected).toBe(false)
  })

  it('返回对象恒为全新引用，不与模块级常量共享（调用方改写不串味）', () => {
    const a = parsePluginLinkStatus(null)
    const b = parsePluginLinkStatus(null)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})
